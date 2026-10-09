import "server-only";

import { HttpError } from "./errors";
import { Db, dbErrorToHttp, serviceDb, supabaseConfig, userDb } from "./supabase";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, type Me, type Role, type SuiteApp } from "@/lib/shared/types";

export { HttpError };

// Session : jetons Supabase Auth dans des cookies HttpOnly (jamais lisibles par le JavaScript de la page)
const ACCESS_COOKIE = "fs_access";
const REFRESH_COOKIE = "fs_refresh";
const MAX_AGE = 7 * 24 * 3600;

type Handler = (req: Request) => Promise<Response>;

/** Cookies à ajouter à la réponse (ex. jeton rafraîchi pendant la requête). */
const pendingCookies = new WeakMap<Request, string[]>();

function addCookie(req: Request, cookie: string): void {
  pendingCookies.set(req, [...(pendingCookies.get(req) ?? []), cookie]);
}

/** Transforme les erreurs en réponses JSON propres et ajoute les cookies en attente. */
export function route(fn: Handler): Handler {
  return async (req) => {
    let res: Response;
    try {
      res = await fn(req);
    } catch (raw) {
      const err = dbErrorToHttp(raw);
      if (err instanceof HttpError) res = json({ error: err.message }, err.status);
      else {
        console.error(err);
        res = json({ error: "Erreur serveur" }, 500);
      }
    }
    for (const cookie of pendingCookies.get(req) ?? []) res.headers.append("Set-Cookie", cookie);
    return res;
  };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > 10_000) throw new HttpError(413, "Requête trop volumineuse");
  try {
    const data: unknown = JSON.parse(text || "{}");
    if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error();
    return data as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "JSON invalide");
  }
}

export function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

function cookie(req: Request, name: string, value: string | null): string {
  const secure = new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
  const v = value ? `${name}=${encodeURIComponent(value)}; Max-Age=${MAX_AGE}` : `${name}=; Max-Age=0`;
  return `${v}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

/** Limite simple par IP, partagée entre toutes les fonctions via la base. */
export async function rateLimit(req: Request, bucket: string, max: number, windowSeconds = 60): Promise<void> {
  const n = await serviceDb().rpc<number>("suite_hit_rate_limit", { p_key: `flexstaff:${bucket}:${clientIp(req)}`, p_window_seconds: windowSeconds });
  if (n > max) throw new HttpError(429, "Trop de tentatives, réessaie dans une minute");
}

// --- Comptes (Supabase Auth) ----------------------------------------------

/** Compte connecté */
interface SessionContext {
  /** Accès à la base avec le jeton du compte : la RLS et les fonctions de la base décident */
  db: Db;
  userId: string;
  email: string;
}

export interface AdminContext extends SessionContext {
  /** Applis dont le compte est admin (toutes pour un super admin) */
  apps: SuiteApp[];
}

/** Compte avec un rôle dans Flexform (admin, super admin compris, ou staff) : accès à /staff */
export interface FlexformStaffContext extends SessionContext {
  role: Role;
}

interface Tokens {
  access_token: string;
  refresh_token: string;
}

/** Contenu (non vérifié) du jeton. La vérification est faite par Supabase à chaque requête. */
function jwtPayload(token: string): { sub?: string; email?: string; exp?: number } {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { sub?: string; email?: string; exp?: number };
  } catch {
    return {};
  }
}

async function authRequest(grant: "password" | "refresh_token", body: object): Promise<Tokens | null> {
  const cfg = supabaseConfig();
  const res = await fetch(`${cfg.url}/auth/v1/token?grant_type=${grant}`, {
    method: "POST",
    headers: { apikey: cfg.anonKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  return (await res.json()) as Tokens;
}

function setTokens(req: Request, tokens: Tokens | null): void {
  addCookie(req, cookie(req, ACCESS_COOKIE, tokens?.access_token ?? null));
  addCookie(req, cookie(req, REFRESH_COOKIE, tokens?.refresh_token ?? null));
}

/** Applis administrées par le compte du jeton, lues dans la base (fonction suite_my_apps). */
async function adminApps(db: Db): Promise<SuiteApp[]> {
  return db.rpc<SuiteApp[]>("suite_my_apps");
}

/** Rôle du compte du jeton dans Flexform, lu dans la base (fonction suite_app_role ; super admin : admin). */
async function flexformRole(db: Db): Promise<Role | null> {
  const role = await db.rpc<string | null>("suite_app_role", { p_app: "flexform" });
  return role === "admin" || role === "staff" ? role : null;
}

/** Ce que le compte du jeton peut faire dans Flexstaff : applis administrées, page /staff. */
async function accountOf(db: Db, email: string): Promise<Me> {
  const [apps, superAdmin, role] = await Promise.all([adminApps(db), db.rpc<boolean>("suite_is_super_admin"), flexformRole(db)]);
  return { email, superAdmin, apps, staffPage: role !== null };
}

const NO_ACCESS = "Flexstaff est réservé aux admins d'une appli de la suite et au staff de Flexform.";
const ADMIN_ONLY = "La gestion des équipes est réservée aux admins d'une appli de la suite.";
const NO_STAFF_ROLE = "Ce compte n'a pas de rôle admin ou staff dans Flexform.";

/** Connexion. Refusée (sans cookie) si le compte n'est admin d'aucune appli et n'a pas de rôle dans Flexform. */
export async function signIn(req: Request, email: string, password: string): Promise<Me> {
  await rateLimit(req, "login", 10);
  const tokens = await authRequest("password", { email, password });
  if (!tokens) throw new HttpError(401, "E-mail ou mot de passe incorrect");
  const me = await accountOf(userDb(tokens.access_token), jwtPayload(tokens.access_token).email ?? email);
  if (!me.apps.length && !me.staffPage) throw new HttpError(403, NO_ACCESS);
  setTokens(req, tokens);
  return me;
}

export function signOut(req: Request): void {
  setTokens(req, null);
}

/** Nouveau mot de passe choisi par quelqu'un : longueur vérifiée ici, le reste par Supabase Auth. */
export function parseNewPassword(value: unknown): string {
  const password = typeof value === "string" ? value : "";
  if (password.length < MIN_PASSWORD_LENGTH) throw new HttpError(400, `Mot de passe trop court : ${MIN_PASSWORD_LENGTH} caractères minimum.`);
  if (Buffer.byteLength(password) > MAX_PASSWORD_LENGTH) throw new HttpError(400, `Mot de passe trop long : ${MAX_PASSWORD_LENGTH} octets maximum.`);
  return password;
}

/** Mot de passe refusé par Supabase Auth (trop faible, identique à l'ancien...) : 400 avec un message lisible. */
export async function passwordRefused(res: Response): Promise<HttpError | null> {
  if (res.status !== 422 && res.status !== 400) return null;
  const err = (await res.json().catch(() => ({}))) as { error_code?: string; code?: string };
  const code = err.error_code ?? err.code;
  if (code === "same_password") return new HttpError(400, "Le nouveau mot de passe doit être différent de l'ancien.");
  if (code === "weak_password") return new HttpError(400, "Mot de passe trop faible.");
  return null;
}

/**
 * Change le mot de passe du compte connecté. L'actuel est vérifié par une connexion (même limite de tentatives
 * que la connexion), puis le changement est fait avec le jeton de cette nouvelle session, qui remplace l'ancienne.
 * 400 (et non 401) si l'actuel est faux : la session reste ouverte.
 */
export async function changePassword(req: Request, ctx: AdminContext, current: unknown, next: unknown): Promise<void> {
  const password = parseNewPassword(next);
  if (typeof current !== "string" || !current) throw new HttpError(400, "Mot de passe actuel requis.");
  await rateLimit(req, "login", 10);
  const tokens = await authRequest("password", { email: ctx.email, password: current });
  if (!tokens) throw new HttpError(400, "Mot de passe actuel incorrect.");

  const cfg = supabaseConfig();
  const res = await fetch(`${cfg.url}/auth/v1/user`, {
    method: "PUT",
    headers: { apikey: cfg.anonKey, Authorization: `Bearer ${tokens.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw (await passwordRefused(res)) ?? new Error(`Changement de mot de passe refusé par Supabase Auth (${res.status})`);
  setTokens(req, tokens);
}

/** Compte connecté, sans vérifier ses droits. Le jeton est rafraîchi s'il expire bientôt. */
async function session(req: Request): Promise<SessionContext> {
  let access = readCookie(req, ACCESS_COOKIE);
  const refresh = readCookie(req, REFRESH_COOKIE);
  if (!access && !refresh) throw new HttpError(401, "Connecte-toi avec ton compte.");

  const exp = access ? (jwtPayload(access).exp ?? 0) : 0;
  if (!access || exp * 1000 < Date.now() + 30_000) {
    const tokens = refresh ? await authRequest("refresh_token", { refresh_token: refresh }) : null;
    if (!tokens) {
      signOut(req);
      throw new HttpError(401, "Session expirée, reconnecte-toi.");
    }
    setTokens(req, tokens);
    access = tokens.access_token;
  }

  const payload = jwtPayload(access);
  return { db: userDb(access), userId: payload.sub ?? "", email: payload.email ?? "" };
}

/*
 * Les droits sont relus dans la base à chaque requête : un rôle retiré coupe l'accès aussitôt.
 * Le droit sur une appli précise est vérifié par la base elle-même (fonctions et RLS).
 */

/** Compte connecté, admin d'au moins une appli (gestion des équipes). */
export async function requireAdmin(req: Request): Promise<AdminContext> {
  const ctx = await session(req);
  const apps = await adminApps(ctx.db);
  if (!apps.length) throw new HttpError(403, ADMIN_ONLY);
  return { ...ctx, apps };
}

/** Compte connecté, admin d'une appli ou avec un rôle dans Flexform : ce qu'il peut faire dans Flexstaff. */
export async function requireAccount(req: Request): Promise<Me> {
  const ctx = await session(req);
  const me = await accountOf(ctx.db, ctx.email);
  if (!me.apps.length && !me.staffPage) throw new HttpError(403, NO_ACCESS);
  return me;
}

/**
 * Compte connecté avec le rôle admin ou staff dans Flexform (page /staff). Ses actions sur les tables
 * sondage_* de Flexform passent par son propre jeton : la RLS de Flexform décide.
 */
export async function requireFlexformStaff(req: Request): Promise<FlexformStaffContext> {
  const ctx = await session(req);
  const role = await flexformRole(ctx.db);
  if (!role) throw new HttpError(403, NO_STAFF_ROLE);
  return { ...ctx, role };
}

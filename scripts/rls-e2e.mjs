/**
 * Vérifie les droits de la suite directement dans la base, avec le jeton de chaque rôle :
 * visiteur, staff Flexform, admin Flexform, admin Flexfolio, super admin.
 * Base LOCALE uniquement (npm run db:start) : le test crée et supprime des données.
 * La garde du dernier admin est testée en SQL dans le conteneur Docker de la base, dans des transactions annulées.
 *
 *   npm run test:rls
 */
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";

const { SUPABASE_URL: SB, SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: SERVICE } = process.env;
if (!SB?.includes("127.0.0.1") && !SB?.includes("localhost")) {
  console.error("Refusé : SUPABASE_URL ne pointe pas vers une base locale.");
  process.exit(1);
}

let failures = 0;
function check(label, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` -> ${detail}` : ""}`);
}

async function rest(bearer, path, { method = "GET", body, prefer } = {}) {
  const res = await fetch(`${SB}/rest/v1/${path}`, {
    method,
    headers: { apikey: ANON, Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

async function token(email, password) {
  const res = await fetch(`${SB}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Connexion impossible pour ${email} (lancer npm run role pour créer les comptes de test)`);
  return { jwt: data.access_token, id: data.user.id };
}

/** Écriture refusée : erreur HTTP, ou aucune ligne touchée (RLS filtre silencieusement). */
const refused = (r) => r.status >= 400 || (Array.isArray(r.data) && r.data.length === 0);
const rpc = (bearer, fn, args = {}) => rest(bearer, `rpc/${fn}`, { method: "POST", body: args });

async function upload(bearer, name) {
  const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
  const res = await fetch(`${SB}/storage/v1/object/project-images/${name}`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${bearer}`, "Content-Type": "image/png" },
    body: png,
  });
  return res.status;
}

/** Joue des requêtes SQL dans une transaction toujours annulée, en superutilisateur dans le conteneur de la base locale. */
function sqlRolledBack(lines) {
  const sql = ["begin;", ...lines, "rollback;"].join("\n");
  const r = spawnSync("docker", ["exec", "-i", "supabase_db_flexstaff", "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"], { input: sql, encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error?.message ?? ""}` };
}
/** Requêtes suivantes jouées comme ce compte connecté (même rôle et même auth.uid() qu'avec son jeton). */
const asUser = (who) => [
  "set local role authenticated;",
  `select set_config('request.jwt.claims', '${JSON.stringify({ sub: who.id, role: "authenticated" })}', true);`,
];

const env = process.env;
const staff = await token(env.TEST_STAFF_EMAIL, env.TEST_STAFF_PASSWORD);
const formAdmin = await token(env.TEST_ADMIN_EMAIL, env.TEST_ADMIN_PASSWORD);
const folioAdmin = await token(env.TEST_FOLIO_EMAIL, env.TEST_FOLIO_PASSWORD);
const superAdmin = await token(env.TEST_SUPER_EMAIL, env.TEST_SUPER_PASSWORD);

// Données de test : un projet visible et un masqué
await rest(SERVICE, "projects?slug=like.rls-*", { method: "DELETE" });
await rest(SERVICE, "projects", { method: "POST", body: [
  { title: "Visible", slug: "rls-visible", is_visible: true },
  { title: "Masqué", slug: "rls-hidden", is_visible: false },
] });

console.log("\n# Rôles calculés par la base");
const roleOf = async (who, app) => (await rpc(who.jwt, "suite_app_role", { p_app: app })).data;
check("staff Flexform : staff dans flexform, rien dans flexfolio", (await roleOf(staff, "flexform")) === "staff" && (await roleOf(staff, "flexfolio")) === null);
check("admin Flexform : admin dans flexform, rien dans flexfolio", (await roleOf(formAdmin, "flexform")) === "admin" && (await roleOf(formAdmin, "flexfolio")) === null);
check("admin Flexfolio : admin dans flexfolio, rien dans flexform", (await roleOf(folioAdmin, "flexfolio")) === "admin" && (await roleOf(folioAdmin, "flexform")) === null);
check("super admin : admin partout", (await roleOf(superAdmin, "flexfolio")) === "admin" && (await roleOf(superAdmin, "flexform")) === "admin");
check("Flexdesign : aucun rôle pour les comptes des autres applis", (await roleOf(staff, "flexdesign")) === null && (await roleOf(formAdmin, "flexdesign")) === null && (await roleOf(folioAdmin, "flexdesign")) === null);
check("Flexdesign : super admin y est admin", (await roleOf(superAdmin, "flexdesign")) === "admin");
check("super admin reconnu, les autres non", (await rpc(superAdmin.jwt, "suite_is_super_admin")).data === true && (await rpc(formAdmin.jwt, "suite_is_super_admin")).data === false);
check("Flexform voit toujours son rôle par sondage_role()", (await rpc(staff.jwt, "sondage_role")).data === "staff");

console.log("\n# Tables de droits");
for (const table of ["suite_apps", "suite_super_admins", "app_roles"]) {
  const r = await rest(ANON, `${table}?select=*`);
  check(`visiteur ne lit rien dans ${table}`, r.status >= 400 || r.data.length === 0, `${r.status}`);
}
const staffRoles = await rest(staff.jwt, "app_roles?select=user_id,app,role");
check("staff ne lit que sa propre ligne", staffRoles.data.length === 1 && staffRoles.data[0].user_id === staff.id, JSON.stringify(staffRoles.data));
const formAdminRoles = await rest(formAdmin.jwt, "app_roles?select=app");
check("admin Flexform lit les droits de flexform, pas ceux de flexfolio", formAdminRoles.data.length >= 2 && formAdminRoles.data.every((r) => r.app === "flexform"), JSON.stringify(formAdminRoles.data));
check("super admin lit tous les droits", (await rest(superAdmin.jwt, "app_roles?select=app")).data.some((r) => r.app === "flexfolio"));

check("staff ne peut pas se donner le rôle admin", refused(await rest(staff.jwt, `app_roles?user_id=eq.${staff.id}&app=eq.flexform`, { method: "PATCH", body: { role: "admin" }, prefer: "return=representation" })));
check("staff ne peut pas se donner un rôle Flexfolio", refused(await rest(staff.jwt, "app_roles", { method: "POST", body: { user_id: staff.id, app: "flexfolio", role: "admin" } })));
check("admin Flexform ne peut pas se donner un rôle Flexfolio", refused(await rest(formAdmin.jwt, "app_roles", { method: "POST", body: { user_id: formAdmin.id, app: "flexfolio", role: "admin" } })));
check("admin Flexfolio ne peut pas toucher aux droits de Flexform", refused(await rest(folioAdmin.jwt, `app_roles?user_id=eq.${staff.id}&app=eq.flexform`, { method: "DELETE", prefer: "return=representation" })));
check("admin Flexform ne peut pas déplacer un droit vers un autre compte", (await rest(formAdmin.jwt, `app_roles?user_id=eq.${staff.id}&app=eq.flexform`, { method: "PATCH", body: { user_id: folioAdmin.id } })).status >= 400);
for (const [who, label] of [[staff, "staff"], [formAdmin, "admin Flexform"], [superAdmin, "super admin"]]) {
  const r = await rest(who.jwt, "suite_super_admins", { method: "POST", body: { user_id: who.id } });
  check(`${label} ne peut pas créer de super admin depuis une appli`, r.status >= 400, `${r.status}`);
}
check("personne ne peut ajouter une appli depuis une appli", (await rest(superAdmin.jwt, "suite_apps", { method: "POST", body: { app: "pirate", name: "x" } })).status >= 400);

const promote = await rest(formAdmin.jwt, `app_roles?user_id=eq.${staff.id}&app=eq.flexform`, { method: "PATCH", body: { role: "admin" }, prefer: "return=representation" });
check("admin Flexform promeut un staff en admin", promote.status === 200 && promote.data[0]?.role === "admin", JSON.stringify(promote));
const demote = await rest(formAdmin.jwt, `app_roles?user_id=eq.${staff.id}&app=eq.flexform`, { method: "PATCH", body: { role: "staff" }, prefer: "return=representation" });
check("admin Flexform rétrograde un admin en staff", demote.data?.[0]?.role === "staff");
check("super admin gère aussi les droits de Flexfolio", !refused(await rest(superAdmin.jwt, `app_roles?user_id=eq.${folioAdmin.id}&app=eq.flexfolio`, { method: "PATCH", body: { role: "admin" }, prefer: "return=representation" })));

console.log("\n# Équipe (Flexstaff)");
for (const [fn, args] of [["suite_my_apps", {}], ["suite_team", { p_app: "flexform" }], ["suite_user_id_by_email", { p_email: env.TEST_STAFF_EMAIL }]]) {
  const r = await rpc(ANON, fn, args);
  check(`visiteur ne peut pas appeler ${fn}`, r.status >= 400, `${r.status}`);
}
const myApps = async (who) => (await rpc(who.jwt, "suite_my_apps")).data.map((a) => a.app).sort().join(",");
const allApps = (await rest(SERVICE, "suite_apps?select=app")).data.map((a) => a.app).sort().join(",");
check("admin Flexform ne gère que flexform", (await myApps(formAdmin)) === "flexform");
check("admin Flexfolio ne gère que flexfolio", (await myApps(folioAdmin)) === "flexfolio");
check("staff Flexform ne gère aucune appli", (await myApps(staff)) === "");
check("super admin gère toutes les applis", (await myApps(superAdmin)) === allApps, allApps);

const team = await rpc(formAdmin.jwt, "suite_team", { p_app: "flexform" });
const roleIn = (id) => team.data?.filter?.((m) => m.user_id === id).map((m) => m.role).join(",");
check("admin Flexform lit l'équipe de flexform", team.status === 200 && roleIn(formAdmin.id) === "admin" && roleIn(staff.id) === "staff", JSON.stringify(team));
check("l'équipe liste chaque super admin une fois, avec le rôle super", roleIn(superAdmin.id) === "super");
check("l'équipe de flexform ne contient pas les droits de flexfolio", team.data?.every?.((m) => m.user_id !== folioAdmin.id));
check("staff Flexform ne peut pas lire l'équipe de flexform", (await rpc(staff.jwt, "suite_team", { p_app: "flexform" })).status === 403);
check("admin Flexform ne peut pas lire l'équipe de flexfolio", (await rpc(formAdmin.jwt, "suite_team", { p_app: "flexfolio" })).status === 403);
check("équipe refusée quand l'appli est inconnue, même pour un super admin", (await rpc(superAdmin.jwt, "suite_team", { p_app: "inconnue" })).status === 404);

check("staff Flexform ne peut pas chercher un compte par e-mail", (await rpc(staff.jwt, "suite_user_id_by_email", { p_email: env.TEST_ADMIN_EMAIL })).status === 403);
const found = await rpc(formAdmin.jwt, "suite_user_id_by_email", { p_email: ` ${env.TEST_STAFF_EMAIL.toUpperCase()} ` });
check("admin Flexform retrouve un compte par e-mail (casse et espaces ignorés)", found.data === staff.id, JSON.stringify(found));

await rest(SERVICE, "suite_rate_limits?key=like.rls-*", { method: "DELETE" });
const hit = async () => (await rpc(SERVICE, "suite_hit_rate_limit", { p_key: "rls-limite", p_window_seconds: 60 })).data;
check("le serveur (service_role) compte les tentatives", (await hit()) === 1 && (await hit()) === 2);
for (const [who, label] of [[{ jwt: ANON }, "visiteur"], [staff, "staff Flexform"], [superAdmin, "super admin"]]) {
  const call = await rpc(who.jwt, "suite_hit_rate_limit", { p_key: "rls-limite", p_window_seconds: 60 });
  check(`${label} ne peut pas appeler suite_hit_rate_limit`, call.status >= 400, `${call.status}`);
  const read = await rest(who.jwt, "suite_rate_limits?select=*");
  check(`${label} ne lit rien dans suite_rate_limits`, read.status >= 400 || read.data.length === 0, `${read.status}`);
  check(`${label} ne peut pas écrire dans suite_rate_limits`, refused(await rest(who.jwt, "suite_rate_limits", { method: "POST", body: { key: "rls-pirate", hits: 0, reset_at: "2100-01-01T00:00:00Z" }, prefer: "return=representation" })));
  check(`${label} ne peut pas remettre un compteur à zéro`, refused(await rest(who.jwt, "suite_rate_limits?key=eq.rls-limite", { method: "DELETE", prefer: "return=representation" })));
}
check("le compteur n'a pas bougé", (await hit()) === 3);

console.log("\n# Mot de passe d'un membre (Flexstaff)");
const resetTarget = (who, userId) => rpc(who.jwt, "suite_password_reset_target", { p_user: userId });
check("visiteur ne peut pas appeler suite_password_reset_target", (await rpc(ANON, "suite_password_reset_target", { p_user: staff.id })).status >= 400);
check("staff Flexform ne peut pas changer un mot de passe", (await resetTarget(staff, formAdmin.id)).status === 403);
const staffTarget = await resetTarget(formAdmin, staff.id);
check("admin Flexform peut changer le mot de passe de son staff", staffTarget.status === 200 && staffTarget.data?.toLowerCase() === env.TEST_STAFF_EMAIL.toLowerCase(), JSON.stringify(staffTarget));
check("admin Flexform ne peut pas changer le mot de passe d'un super admin", (await resetTarget(formAdmin, superAdmin.id)).status === 409);
check("admin Flexform ne peut pas changer le mot de passe de l'admin Flexfolio", (await resetTarget(formAdmin, folioAdmin.id)).status === 409);
check("admin Flexfolio ne peut pas changer le mot de passe du staff Flexform", (await resetTarget(folioAdmin, staff.id)).status === 409);
check("son propre mot de passe refusé par cette fonction", (await resetTarget(formAdmin, formAdmin.id)).status === 400);
check("compte sans rôle refusé, même pour un super admin", (await resetTarget(superAdmin, "00000000-0000-0000-0000-000000000000")).status === 404);
check("super admin peut changer le mot de passe des comptes de chaque appli", (await resetTarget(superAdmin, staff.id)).status === 200 && (await resetTarget(superAdmin, folioAdmin.id)).status === 200);
const twoApps = sqlRolledBack([
  `insert into public.app_roles (user_id, app, role) values ('${staff.id}', 'flexfolio', 'staff');`,
  ...asUser(formAdmin),
  `select public.suite_password_reset_target('${staff.id}');`,
]);
check("admin Flexform ne peut pas changer le mot de passe d'un staff qui a aussi un rôle dans Flexfolio", !twoApps.ok && twoApps.out.includes("PT409"), twoApps.out);

console.log("\n# Garde du dernier admin");
// Appli de test créée dans chaque transaction, puis annulée : les comptes de test et les super admins ne changent pas.
const garde = (roles) => [
  "insert into public.suite_apps (app, name) values ('rls-garde', 'Garde');",
  `insert into public.app_roles (user_id, app, role) values ${roles.map(([who, role]) => `('${who.id}', 'rls-garde', '${role}')`).join(", ")};`,
];
const lastAdmin = (r) => !r.ok && r.out.includes("PT409") && r.out.includes("Il doit rester au moins un admin dans cette appli.");
const noSuper = "delete from public.suite_super_admins;";
const superBefore = (await rest(SERVICE, "suite_super_admins?select=user_id")).data.length;
let r = sqlRolledBack([...garde([[formAdmin, "admin"], [staff, "staff"]]), noSuper, ...asUser(formAdmin), "update public.app_roles set role = 'staff' where user_id = auth.uid() and app = 'rls-garde';"]);
check("dernier admin ne peut pas se rétrograder quand aucun super admin n'existe", lastAdmin(r), r.out);
r = sqlRolledBack([...garde([[formAdmin, "admin"], [staff, "staff"]]), noSuper, ...asUser(formAdmin), "delete from public.app_roles where user_id = auth.uid() and app = 'rls-garde';"]);
check("dernier admin ne peut pas retirer son droit quand aucun super admin n'existe", lastAdmin(r), r.out);
r = sqlRolledBack([...garde([[formAdmin, "admin"], [staff, "admin"]]), noSuper, ...asUser(formAdmin), "update public.app_roles set role = 'staff' where user_id = auth.uid() and app = 'rls-garde';"]);
check("un admin se rétrograde quand un autre admin reste, sans super admin", r.ok && r.out.includes("UPDATE 1"), r.out);
r = sqlRolledBack([...garde([[formAdmin, "admin"]]), ...asUser(formAdmin), "update public.app_roles set role = 'staff' where user_id = auth.uid() and app = 'rls-garde';"]);
check("le dernier admin se rétrograde quand un super admin existe", r.ok && r.out.includes("UPDATE 1"), r.out);
r = sqlRolledBack([...garde([[formAdmin, "admin"]]), ...asUser(superAdmin), `delete from public.app_roles where user_id = '${formAdmin.id}' and app = 'rls-garde';`]);
check("super admin retire le dernier admin d'une appli", r.ok && r.out.includes("DELETE 1"), r.out);
check("la garde ne laisse rien en base", (await rest(SERVICE, "suite_apps?app=eq.rls-garde")).data.length === 0 && (await rest(SERVICE, "suite_super_admins?select=user_id")).data.length === superBefore);

console.log("\n# Flexfolio");
const visibleTo = async (bearer) => (await rest(bearer, "projects?select=slug&slug=like.rls-*")).data.map((p) => p.slug).sort().join(",");
check("visiteur voit seulement le projet visible", (await visibleTo(ANON)) === "rls-visible");
check("staff et admin Flexform ne voient pas le projet masqué", (await visibleTo(staff.jwt)) === "rls-visible" && (await visibleTo(formAdmin.jwt)) === "rls-visible");
check("admin Flexfolio et super admin voient le projet masqué", (await visibleTo(folioAdmin.jwt)) === "rls-hidden,rls-visible" && (await visibleTo(superAdmin.jwt)) === "rls-hidden,rls-visible");
for (const [who, label] of [[{ jwt: ANON }, "visiteur"], [staff, "staff Flexform"], [formAdmin, "admin Flexform"]]) {
  check(`${label} ne crée pas de projet`, refused(await rest(who.jwt, "projects", { method: "POST", body: { title: "x", slug: "rls-pirate" }, prefer: "return=representation" })));
  check(`${label} ne modifie pas les réglages du site`, refused(await rest(who.jwt, "site_settings?id=eq.1", { method: "PATCH", body: { site_name: "piraté" }, prefer: "return=representation" })));
  check(`${label} ne supprime pas de projet`, refused(await rest(who.jwt, "projects?slug=eq.rls-visible", { method: "DELETE", prefer: "return=representation" })));
}
const created = await rest(folioAdmin.jwt, "projects", { method: "POST", body: { title: "Nouveau", slug: "rls-new" }, prefer: "return=representation" });
check("admin Flexfolio crée un projet", created.status === 201, JSON.stringify(created));
const settings = await rest(superAdmin.jwt, "site_settings?id=eq.1", { method: "PATCH", body: { site_name: "Prénom Nom" }, prefer: "return=representation" });
check("super admin modifie les réglages du site", settings.data?.length === 1);
check("staff Flexform n'envoie pas d'image dans le stockage du portfolio", (await upload(staff.jwt, "rls-staff.png")) >= 400);
const up = await upload(folioAdmin.jwt, "rls-folio.png");
check("admin Flexfolio envoie une image", up === 200, `${up}`);

console.log("\n# Flexform");
check("super admin lit les votes de Flexform", (await rest(superAdmin.jwt, "sondage_votes?select=poll_id")).status === 200);
check("admin Flexfolio ne lit pas les participants de Flexform", (await rest(folioAdmin.jwt, "sondage_participants?select=id")).data.length === 0);

console.log("\n# Flexform : sondages réservés au staff");
// Sondages de test : réservé au staff et ouvert, réservé au staff hors du hub, sondage normal ouvert
await rest(SERVICE, "sondage_polls?id=like.rls-*", { method: "DELETE" });
const testPoll = (id, staffOnly, hub) => ({ id, kind: "choice", question: id, options: [{ id: "0", label: "Oui" }], staff_only: staffOnly, hub });
await rest(SERVICE, "sondage_polls", { method: "POST", body: [testPoll("rls-staff", true, true), testPoll("rls-staff-off", true, false), testPoll("rls-public", false, true)] });
const answer = (who, pollId, userId = who.id) =>
  rest(who.jwt, "sondage_staff_votes", { method: "POST", body: { poll_id: pollId, user_id: userId, value: "0" }, prefer: "return=representation" });
const staffVotes = (who) => rest(who.jwt, "sondage_staff_votes?select=user_id&poll_id=like.rls-*");

check("staff Flexform répond à un sondage réservé au staff", (await answer(staff, "rls-staff")).status === 201);
check("admin Flexform répond à un sondage réservé au staff", (await answer(formAdmin, "rls-staff")).status === 201);
check("staff Flexform ne peut pas répondre en son nom à un sondage normal", refused(await answer(staff, "rls-public")));
check("staff Flexform ne peut pas répondre à un sondage staff hors du hub", refused(await answer(staff, "rls-staff-off")));
check("staff Flexform ne peut pas répondre au nom d'un autre compte", refused(await answer(staff, "rls-staff", superAdmin.id)));
check("admin Flexfolio ne peut pas répondre à un sondage staff", refused(await answer(folioAdmin, "rls-staff")));
check("visiteur ne lit rien dans sondage_staff_votes", refused(await staffVotes({ jwt: ANON })));
check("visiteur ne peut pas répondre", refused(await rest(ANON, "sondage_staff_votes", { method: "POST", body: { poll_id: "rls-staff", user_id: staff.id, value: "0" } })));
const seenByStaff = (await staffVotes(staff)).data;
check("staff Flexform ne lit que ses propres réponses", seenByStaff.length === 1 && seenByStaff[0].user_id === staff.id, JSON.stringify(seenByStaff));
check("admin Flexform lit toutes les réponses du staff", (await staffVotes(formAdmin)).data.length === 2);
check("admin Flexfolio ne lit pas les réponses du staff", (await staffVotes(folioAdmin)).data.length === 0);
const moved = await rest(staff.jwt, `sondage_staff_votes?poll_id=eq.rls-staff&user_id=eq.${staff.id}`, { method: "PATCH", body: { user_id: superAdmin.id }, prefer: "return=representation" });
check("staff Flexform ne peut pas donner sa réponse à un autre compte", refused(moved), JSON.stringify(moved));
check("staff Flexform ne peut pas effacer les réponses", refused(await rest(staff.jwt, "sondage_staff_votes?poll_id=eq.rls-staff", { method: "DELETE", prefer: "return=representation" })));
const withReward = await rest(SERVICE, "sondage_polls?id=eq.rls-staff", { method: "PATCH", body: { reward: "1 café" } });
check("un sondage réservé au staff refuse une récompense", withReward.status >= 400, `${withReward.status}`);
await rest(SERVICE, "sondage_polls?id=eq.rls-staff", { method: "DELETE" });
check("supprimer le sondage efface les réponses du staff", (await rest(SERVICE, "sondage_staff_votes?select=user_id&poll_id=eq.rls-staff")).data.length === 0);

console.log("\n# Flexdesign : thèmes et polices");
// Le staff Flexform reçoit un rôle staff Flexdesign le temps de cette partie (retiré au nettoyage)
await rest(SERVICE, "design_themes?name=like.rls-*", { method: "DELETE" });
await rest(SERVICE, "app_roles?on_conflict=user_id,app", { method: "POST", body: { user_id: staff.id, app: "flexdesign", role: "staff" }, prefer: "resolution=merge-duplicates" });
check("staff Flexform est staff de Flexdesign pour ce test", (await roleOf(staff, "flexdesign")) === "staff");

const roles = ["background", "surface", "text", "muted", "border", "primary", "onPrimary", "accent", "onAccent", "success", "warning", "danger"];
const roleColors = (mode) => roles.map((name, position) => ({ mode, kind: "role", name, hex: `#${(position * 16).toString(16).padStart(2, "0")}3366`, position }));
const theme = (name, colors, hasDark = false) => ({ p_theme: { name, has_dark: hasDark, colors, fonts: [] } });
const saveTheme = (who, args) => rpc(who.jwt, "design_save_theme", args);

const saved = await saveTheme(superAdmin, theme("rls-theme", roleColors("light")));
const themeId = saved.data;
check("super admin crée un thème par design_save_theme", saved.status === 200 && /^[0-9a-f-]{36}$/.test(themeId ?? ""), JSON.stringify(saved));

for (const table of ["design_themes", "design_theme_colors", "design_fonts", "design_font_files", "design_theme_fonts"]) {
  const read = await rest(ANON, `${table}?select=*&limit=1`);
  check(`visiteur lit ${table}`, read.status === 200, `${read.status}`);
}
check("visiteur lit les 12 couleurs du thème", (await rest(ANON, `design_theme_colors?select=name&theme_id=eq.${themeId}`)).data?.length === 12);
check("visiteur ne peut pas créer de thème", refused(await rest(ANON, "design_themes", { method: "POST", body: { name: "rls-pirate" }, prefer: "return=representation" })));
const anonSave = await rpc(ANON, "design_save_theme", theme("rls-pirate", roleColors("light")));
check("visiteur ne peut pas appeler design_save_theme", anonSave.status >= 400, `${anonSave.status}`);

const staffSave = await saveTheme(staff, theme("rls-pirate", roleColors("light")));
check("staff Flexdesign ne peut pas appeler design_save_theme", staffSave.status === 403 && staffSave.data?.code === "PT403", JSON.stringify(staffSave));
check("staff Flexdesign ne peut pas créer de thème directement", refused(await rest(staff.jwt, "design_themes", { method: "POST", body: { name: "rls-pirate" }, prefer: "return=representation" })));
check("staff Flexdesign ne peut pas modifier un thème", refused(await rest(staff.jwt, `design_themes?id=eq.${themeId}`, { method: "PATCH", body: { name: "rls-piraté" }, prefer: "return=representation" })));
check("staff Flexdesign ne peut pas modifier les couleurs d'un thème", refused(await rest(staff.jwt, `design_theme_colors?theme_id=eq.${themeId}`, { method: "PATCH", body: { hex: "#000000" }, prefer: "return=representation" })));
check("staff Flexdesign ne peut pas supprimer un thème", refused(await rest(staff.jwt, `design_themes?id=eq.${themeId}`, { method: "DELETE", prefer: "return=representation" })));
const font = { family: "Rls Pirate", label: "rls-pirate", source: "catalog", catalog_id: "rls-pirate", category: "sans-serif", license: "OFL-1.1" };
check("staff Flexdesign ne peut pas ajouter de police", refused(await rest(staff.jwt, "design_fonts", { method: "POST", body: font, prefer: "return=representation" })));
const intact = (await rest(SERVICE, `design_themes?select=name&id=eq.${themeId}`)).data;
check("le thème est intact après les tentatives du staff", intact?.[0]?.name === "rls-theme" && (await rest(SERVICE, `design_theme_colors?select=hex&theme_id=eq.${themeId}&hex=eq.%23000000`)).data.length === 0);
for (const [who, label] of [[formAdmin, "admin Flexform"], [folioAdmin, "admin Flexfolio"]]) {
  const call = await saveTheme(who, theme("rls-pirate", roleColors("light")));
  check(`${label} ne peut pas appeler design_save_theme`, call.status === 403, `${call.status}`);
  check(`${label} ne peut pas ajouter de police`, refused(await rest(who.jwt, "design_fonts", { method: "POST", body: font, prefer: "return=representation" })));
}

const incomplete = await saveTheme(superAdmin, theme("rls-incomplet", roleColors("light").slice(1)));
check("thème refusé quand il manque un rôle, sans rien laisser en base", incomplete.status === 400 && incomplete.data?.code === "PT400" && (await rest(SERVICE, "design_themes?name=eq.rls-incomplet")).data.length === 0, JSON.stringify(incomplete));
for (const hex of ["#ABC", "red", "#ABCDEF"]) {
  const colors = roleColors("light");
  colors[0].hex = hex;
  const bad = await saveTheme(superAdmin, theme("rls-mauvais", colors));
  check(`couleur ${hex} refusée par la base`, bad.status === 400 && bad.data?.code === "23514", JSON.stringify(bad));
}
const darkWithout = await saveTheme(superAdmin, theme("rls-mauvais", [...roleColors("light"), roleColors("dark")[0]]));
check("couleur sombre refusée quand le thème n'a pas de variante sombre", darkWithout.status === 400 && darkWithout.data?.code === "PT400", JSON.stringify(darkWithout));
const namedDark = await saveTheme(superAdmin, theme("rls-mauvais", [...roleColors("light"), ...roleColors("dark"), { mode: "dark", kind: "named", name: "brique", hex: "#aa3322", position: 0 }], true));
check("couleur nommée refusée en mode sombre", namedDark.status === 400 && namedDark.data?.code === "23514", JSON.stringify(namedDark));
check("aucun thème refusé n'est resté en base", (await rest(SERVICE, "design_themes?select=name&name=like.rls-*")).data.map((t) => t.name).join(",") === "rls-theme");

// Stockage des polices : bucket public en lecture, écriture réservée aux admins Flexdesign
const woff2 = Buffer.concat([Buffer.from("wOF2"), Buffer.alloc(12)]);
async function uploadFont(bearer, name, type = "font/woff2") {
  const res = await fetch(`${SB}/storage/v1/object/design-fonts/${name}`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${bearer}`, "Content-Type": type },
    body: woff2,
  });
  return res.status;
}
const publicFont = async (name) => (await fetch(`${SB}/storage/v1/object/public/design-fonts/${name}`)).status;
for (const [who, label, name] of [[{ jwt: ANON }, "visiteur", "rls-anon.woff2"], [staff, "staff Flexdesign", "rls-staff.woff2"], [formAdmin, "admin Flexform", "rls-form.woff2"]]) {
  const status = await uploadFont(who.jwt, name);
  check(`${label} n'envoie pas de police dans design-fonts`, status >= 400, `${status}`);
}
const fontUp = await uploadFont(superAdmin.jwt, "rls-font.woff2");
check("super admin envoie une police woff2", fontUp === 200, `${fontUp}`);
check("visiteur télécharge la police envoyée (bucket public)", (await publicFont("rls-font.woff2")) === 200);
await fetch(`${SB}/storage/v1/object/design-fonts/rls-font.woff2`, { method: "DELETE", headers: { apikey: ANON, Authorization: `Bearer ${staff.jwt}` } });
check("staff Flexdesign ne peut pas supprimer une police du stockage", (await publicFont("rls-font.woff2")) === 200);
const pngUp = await uploadFont(superAdmin.jwt, "rls-image.png", "image/png");
check("le bucket refuse un fichier image/png, même pour un super admin", pngUp >= 400, `${pngUp}`);

console.log("\n# Flexdesign : moodboards");
// Deux comptes de l'équipe Flexdesign le temps de cette partie (rôles retirés au nettoyage) :
// staff A = staff Flexform, staff B = admin Flexform, tous deux staff Flexdesign.
const A = staff;
const B = formAdmin;
const serviceHeaders = { apikey: ANON, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };
/** Supprime les tableaux de test (titre rls-*) et leurs fichiers du bucket design-assets. */
async function purgeBoards() {
  const ids = ((await rest(SERVICE, "design_boards?select=id&title=like.rls-*")).data ?? []).map((b) => b.id);
  for (const prefix of [...ids, "rls-dossier"]) {
    const res = await fetch(`${SB}/storage/v1/object/list/design-assets`, { method: "POST", headers: serviceHeaders, body: JSON.stringify({ prefix, limit: 1000 }) });
    const files = res.ok ? await res.json() : [];
    if (files.length) await fetch(`${SB}/storage/v1/object/design-assets`, { method: "DELETE", headers: serviceHeaders, body: JSON.stringify({ prefixes: files.map((f) => `${prefix}/${f.name}`) }) });
  }
  await rest(SERVICE, "design_boards?title=like.rls-*", { method: "DELETE" });
}
const grantDesign = (who) => rest(SERVICE, "app_roles?on_conflict=user_id,app", { method: "POST", body: { user_id: who.id, app: "flexdesign", role: "staff" }, prefer: "resolution=merge-duplicates" });
await purgeBoards();
await grantDesign(A);
await grantDesign(B);
check("staff A et staff B sont staff de Flexdesign pour ce test", (await roleOf(A, "flexdesign")) === "staff" && (await roleOf(B, "flexdesign")) === "staff");

const newBoard = (who, title, ownerId = who.id) => rest(who.jwt, "design_boards", { method: "POST", body: { title, owner_id: ownerId }, prefer: "return=representation" });
const created1 = await newBoard(A, "rls-tableau");
check("staff A crée un tableau", created1.status === 201 && created1.data?.[0]?.owner_id === A.id, JSON.stringify(created1));
const boardId = created1.data?.[0]?.id;
const otherBoardId = (await newBoard(A, "rls-autre")).data?.[0]?.id;
check("staff A ne peut pas créer un tableau au nom d'un autre compte", refused(await newBoard(A, "rls-pirate", B.id)));
check("admin Flexfolio (sans rôle Flexdesign) ne peut pas créer de tableau", refused(await newBoard(folioAdmin, "rls-pirate")));
check("visiteur ne peut pas créer de tableau", refused(await rest(ANON, "design_boards", { method: "POST", body: { title: "rls-pirate" }, prefer: "return=representation" })));
for (const table of ["design_boards", "design_board_members", "design_board_links", "design_board_items"]) {
  check(`visiteur ne lit rien dans ${table}`, refused(await rest(ANON, `${table}?select=*`)));
}

const item = (board, by, folder = board) => ({ board_id: board, path: `${folder}/${randomUUID()}.png`, mime: "image/png", width_px: 10, height_px: 10, ...(by ? { created_by: by.id } : {}) });
const postItem = (who, body) => rest(who.jwt, "design_board_items", { method: "POST", body, prefer: "return=representation" });
const ownItem = await postItem(A, item(boardId));
check("staff A pose une image sur son tableau", ownItem.status === 201, JSON.stringify(ownItem));
const itemId = ownItem.data?.[0]?.id;
const linkToken = randomBytes(32).toString("base64url");
const link = await rest(A.jwt, "design_board_links", { method: "POST", body: { board_id: boardId, token: linkToken }, prefer: "return=representation" });
check("staff A crée le lien public de son tableau", link.status === 201, JSON.stringify(link));

const access = async (who) => (await rpc(who.jwt, "design_board_access", { p_board: boardId })).data;
const seen = async (who) => {
  const boards = (await rest(who.jwt, `design_boards?select=id&id=eq.${boardId}`)).data;
  const items = (await rest(who.jwt, `design_board_items?select=id&board_id=eq.${boardId}`)).data;
  return `${boards?.length ?? "erreur"} tableau, ${items?.length ?? "erreur"} image(s)`;
};
check("design_board_access renvoie owner pour staff A", (await access(A)) === "owner");
for (const [who, label] of [[B, "staff B"], [superAdmin, "super admin"]]) {
  const s = await seen(who);
  check(`${label} ne lit pas le tableau privé de staff A`, s === "0 tableau, 0 image(s)", s);
  check(`design_board_access renvoie null pour ${label}`, (await access(who)) === null);
}

// Membre en lecture
const members = `design_board_members?board_id=eq.${boardId}`;
const addMember = (who, userId, canEdit = false) => rest(who.jwt, "design_board_members", { method: "POST", body: { board_id: boardId, user_id: userId, can_edit: canEdit }, prefer: "return=representation" });
const patchBoard = (who, body, id = boardId) => rest(who.jwt, `design_boards?id=eq.${id}`, { method: "PATCH", body, prefer: "return=representation" });
const patchItem = (who, id, body) => rest(who.jwt, `design_board_items?id=eq.${id}`, { method: "PATCH", body, prefer: "return=representation" });
const privilegeError = (r) => r.status >= 400 && r.data?.code === "42501";
const memberCannotManage = async (prefix) => {
  check(`${prefix} ne peut pas ajouter de membre`, refused(await addMember(B, superAdmin.id)));
  check(`${prefix} ne peut pas changer les droits d'un membre`, refused(await rest(B.jwt, `${members}&user_id=eq.${B.id}`, { method: "PATCH", body: { can_edit: false }, prefer: "return=representation" })));
  check(`${prefix} ne peut pas retirer de membre`, refused(await rest(B.jwt, members, { method: "DELETE", prefer: "return=representation" })));
  check(`${prefix} ne lit pas le lien public`, refused(await rest(B.jwt, `design_board_links?select=token&board_id=eq.${boardId}`)));
  check(`${prefix} ne peut pas supprimer le lien public`, refused(await rest(B.jwt, `design_board_links?board_id=eq.${boardId}`, { method: "DELETE", prefer: "return=representation" })));
  check(`${prefix} ne peut pas renommer le tableau`, refused(await patchBoard(B, { title: "rls-piraté" })));
  check(`${prefix} ne peut pas ouvrir le tableau à toute l'équipe`, refused(await patchBoard(B, { team_read: true })));
  check(`${prefix} ne peut pas supprimer le tableau`, refused(await rest(B.jwt, `design_boards?id=eq.${boardId}`, { method: "DELETE", prefer: "return=representation" })));
};
const addB = await addMember(A, B.id);
check("staff A partage son tableau avec staff B en lecture", addB.status === 201, JSON.stringify(addB));
check("design_board_access renvoie read pour staff B", (await access(B)) === "read");
check("staff B lit le tableau partagé et ses images", (await seen(B)) === "1 tableau, 1 image(s)");
check("staff B en lecture ne peut pas poser d'image", refused(await postItem(B, item(boardId, B))));
check("staff B en lecture ne peut pas déplacer une image", refused(await patchItem(B, itemId, { x: 50 })));
await memberCannotManage("staff B en lecture");
check("staff A ne peut pas partager avec un compte hors de l'équipe Flexdesign", refused(await addMember(A, folioAdmin.id)));
check("staff A ne peut pas s'ajouter comme membre de son tableau", refused(await addMember(A, A.id)));

// Membre en modification
const setEdit = await rest(A.jwt, `${members}&user_id=eq.${B.id}`, { method: "PATCH", body: { can_edit: true }, prefer: "return=representation" });
check("staff A donne à staff B le droit de modifier", setEdit.data?.[0]?.can_edit === true, JSON.stringify(setEdit));
check("design_board_access renvoie edit pour staff B", (await access(B)) === "edit");
const bItem = await postItem(B, item(boardId, B));
check("staff B en modification pose une image", bItem.status === 201, JSON.stringify(bItem));
const bItemId = bItem.data?.[0]?.id;
const movedItem = await patchItem(B, itemId, { x: 50 });
check("staff B en modification déplace une image", movedItem.data?.[0]?.x === 50, JSON.stringify(movedItem));
const toOther = await patchItem(B, bItemId, { board_id: otherBoardId });
check("staff B ne peut pas déplacer une image vers un autre tableau (droit de colonne)", privilegeError(toOther), JSON.stringify(toOther));
const newPath = await patchItem(B, bItemId, { path: `${boardId}/${randomUUID()}.png` });
check("staff B ne peut pas changer le fichier d'une image (droit de colonne)", privilegeError(newPath), JSON.stringify(newPath));
const foreign = await postItem(B, item(boardId, B, otherBoardId));
check("image refusée quand son fichier est dans le dossier d'un autre tableau", foreign.status === 400 && foreign.data?.code === "23514", JSON.stringify(foreign));
check("staff B ne peut pas poser d'image sur un tableau non partagé", refused(await postItem(B, item(otherBoardId, B))));
check("staff B ne peut pas poser une image au nom d'un autre compte", refused(await postItem(B, item(boardId, A))));
await memberCannotManage("staff B en modification");
check("le tableau, ses membres et son lien sont intacts après les tentatives de staff B",
  (await rest(SERVICE, `design_boards?select=title,team_read&id=eq.${boardId}`)).data?.[0]?.title === "rls-tableau"
  && (await rest(SERVICE, `${members}&select=user_id`)).data?.length === 1
  && (await rest(SERVICE, `design_board_links?select=token&board_id=eq.${boardId}`)).data?.[0]?.token === linkToken);
const ownerChange = await patchBoard(A, { owner_id: B.id });
check("staff A ne peut pas donner son tableau à un autre compte (droit de colonne)", privilegeError(ownerChange), JSON.stringify(ownerChange));

// Lecture par toute l'équipe
check("staff A ouvre son tableau à toute l'équipe en lecture", (await patchBoard(A, { team_read: true })).data?.[0]?.team_read === true);
check("staff A retire staff B des membres", (await rest(A.jwt, `${members}&user_id=eq.${B.id}`, { method: "DELETE", prefer: "return=representation" })).data?.length === 1);
for (const [who, label] of [[B, "staff B (plus membre)"], [superAdmin, "super admin"]]) {
  const s = await seen(who);
  check(`${label} lit le tableau ouvert à l'équipe`, s === "1 tableau, 2 image(s)" && (await access(who)) === "read", s);
}
check("super admin ne peut pas poser d'image sur un tableau ouvert à l'équipe", refused(await postItem(superAdmin, item(boardId, superAdmin))));
check("super admin ne peut pas supprimer un tableau ouvert à l'équipe", refused(await rest(superAdmin.jwt, `design_boards?id=eq.${boardId}`, { method: "DELETE", prefer: "return=representation" })));
check("admin Flexfolio (sans rôle Flexdesign) ne lit pas un tableau ouvert à l'équipe", (await seen(folioAdmin)) === "0 tableau, 0 image(s)");
check("staff A referme son tableau", (await patchBoard(A, { team_read: false })).data?.[0]?.team_read === false);
check("super admin ne lit plus le tableau refermé", (await seen(superAdmin)) === "0 tableau, 0 image(s)");

// Équipe Flexdesign
const anonTeam = await rpc(ANON, "design_team");
check("visiteur ne peut pas appeler design_team", anonTeam.status >= 400, `${anonTeam.status}`);
const folioTeam = await rpc(folioAdmin.jwt, "design_team");
check("admin Flexfolio ne peut pas appeler design_team", folioTeam.status === 403, `${folioTeam.status}`);
const designTeam = await rpc(A.jwt, "design_team");
check("staff A lit l'équipe Flexdesign (staff A et staff B compris)", designTeam.status === 200 && [A.id, B.id].every((id) => designTeam.data?.some?.((m) => m.user_id === id)), JSON.stringify(designTeam.status));

// Lien public
const byToken = (t) => rpc(ANON, "design_board_by_token", { p_token: t });
const shared = await byToken(linkToken);
check("visiteur lit le tableau par son lien public (titre et images)", shared.data?.id === boardId && shared.data?.title === "rls-tableau" && shared.data?.items?.length === 2, JSON.stringify(shared.status));
check("un jeton inconnu ne renvoie rien", (await byToken(randomBytes(32).toString("base64url"))).data === null);
await rest(SERVICE, `app_roles?user_id=eq.${A.id}&app=eq.flexdesign`, { method: "DELETE" });
check("le lien ne renvoie plus rien quand le propriétaire a quitté l'équipe Flexdesign", (await byToken(linkToken)).data === null);
check("staff A sans rôle Flexdesign ne lit plus son propre tableau", (await seen(A)) === "0 tableau, 0 image(s)");
await grantDesign(A);
check("le lien fonctionne de nouveau quand le rôle est rendu", (await byToken(linkToken)).data?.id === boardId);

// Stockage privé design-assets : chaque fichier suit les droits de son tableau
const pngBytes = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
const assetUrl = (path) => `${SB}/storage/v1/object/design-assets/${path}`;
const uploadAsset = async (bearer, path, type = "image/png") => (await fetch(assetUrl(path), { method: "POST", headers: { apikey: ANON, Authorization: `Bearer ${bearer}`, "Content-Type": type }, body: pngBytes })).status;
const downloadAsset = async (bearer, path) => (await fetch(`${SB}/storage/v1/object/authenticated/design-assets/${path}`, { headers: { apikey: ANON, Authorization: `Bearer ${bearer}` } })).status;
const deleteAsset = (bearer, path) => fetch(assetUrl(path), { method: "DELETE", headers: { apikey: ANON, Authorization: `Bearer ${bearer}` } });
const assetPath = `${boardId}/${randomUUID()}.png`;
const assetUp = await uploadAsset(A.jwt, assetPath);
check("staff A envoie une image dans le dossier de son tableau", assetUp === 200, `${assetUp}`);
check("staff A télécharge son image", (await downloadAsset(A.jwt, assetPath)) === 200);
let status = await uploadAsset(B.jwt, `${boardId}/${randomUUID()}.png`);
check("staff B (non membre) ne peut pas envoyer d'image dans le dossier du tableau", status >= 400, `${status}`);
status = await downloadAsset(B.jwt, assetPath);
check("staff B (non membre) ne peut pas télécharger une image du tableau", status >= 400, `${status}`);
status = await downloadAsset(ANON, assetPath);
check("visiteur ne peut pas télécharger une image du bucket privé", status >= 400, `${status}`);
await addMember(A, B.id);
check("staff B en lecture télécharge une image du tableau", (await downloadAsset(B.jwt, assetPath)) === 200);
status = await uploadAsset(B.jwt, `${boardId}/${randomUUID()}.png`);
check("staff B en lecture ne peut pas envoyer d'image", status >= 400, `${status}`);
await deleteAsset(B.jwt, assetPath);
check("staff B en lecture ne peut pas supprimer une image", (await downloadAsset(A.jwt, assetPath)) === 200);
status = await uploadAsset(A.jwt, `${boardId}/${randomUUID()}.svg`, "image/svg+xml");
check("le bucket refuse un fichier image/svg+xml, même pour le propriétaire", status >= 400, `${status}`);
status = await uploadAsset(A.jwt, `rls-dossier/${randomUUID()}.png`);
check("image refusée hors du dossier d'un tableau", status >= 400, `${status}`);
await deleteAsset(A.jwt, assetPath);
check("staff A supprime son image du stockage", (await downloadAsset(A.jwt, assetPath)) >= 400);

console.log("\n# Flexstaff : calendrier et tâches");
// Rôles Flexstaff le temps de cette partie (retirés au nettoyage) : staff Flexform = staff Flexstaff,
// admin Flexform = admin Flexstaff. L'admin Flexfolio reste sans rôle Flexstaff.
const S = staff;
const ADM = formAdmin;
const NOROLE = folioAdmin;
const grantStaff = (who, role) => rest(SERVICE, "app_roles?on_conflict=user_id,app", { method: "POST", body: { user_id: who.id, app: "flexstaff", role }, prefer: "resolution=merge-duplicates" });
await rest(SERVICE, "staff_projects?title=like.rls-*", { method: "DELETE" });
await rest(SERVICE, `app_roles?user_id=in.(${S.id},${ADM.id},${NOROLE.id})&app=eq.flexstaff`, { method: "DELETE" });
await grantStaff(S, "staff");
await grantStaff(ADM, "admin");
check("Flexstaff : staff, admin et sans rôle pour ce test", (await roleOf(S, "flexstaff")) === "staff" && (await roleOf(ADM, "flexstaff")) === "admin" && (await roleOf(NOROLE, "flexstaff")) === null);

const projectBody = (title, dates = {}) => ({
  title, short_description: "Courte", long_description: "Longue",
  event_date: "2026-12-10", communication_start: "2026-11-01", ticketing_open: "2026-11-15", ticketing_close: "2026-12-09", ...dates,
});
const newProject = (who, body) => rest(who.jwt, "staff_projects", { method: "POST", body, prefer: "return=representation" });
const created2 = await newProject(ADM, projectBody("rls-evenement"));
check("admin Flexstaff crée un projet", created2.status === 201, JSON.stringify(created2));
const projectId = created2.data?.[0]?.id;
for (const [who, label] of [[{ jwt: ANON }, "visiteur"], [S, "staff Flexstaff"], [NOROLE, "compte sans rôle Flexstaff"]]) {
  check(`${label} ne peut pas créer de projet`, refused(await newProject(who, projectBody("rls-pirate"))));
}
const lateOpen = await newProject(ADM, projectBody("rls-mauvais", { ticketing_open: "2026-12-09", ticketing_close: "2026-11-15" }));
check("projet refusé quand la billetterie ouvre après sa fermeture", lateOpen.status === 400 && lateOpen.data?.code === "23514", JSON.stringify(lateOpen));
const lateCom = await newProject(ADM, projectBody("rls-mauvais", { communication_start: "2026-12-11" }));
check("projet refusé quand la communication commence après l'événement", lateCom.status === 400 && lateCom.data?.code === "23514", JSON.stringify(lateCom));
const noDate = await newProject(ADM, projectBody("rls-mauvais", { event_date: null }));
check("projet refusé sans date d'événement", noDate.status === 400 && noDate.data?.code === "23502", JSON.stringify(noDate));
const noShort = await newProject(ADM, projectBody("rls-mauvais", { short_description: "" }));
check("projet refusé sans description courte", noShort.status === 400 && noShort.data?.code === "23514", JSON.stringify(noShort));

const patchProject = (who, body) => rest(who.jwt, `staff_projects?id=eq.${projectId}`, { method: "PATCH", body, prefer: "return=representation" });
check("staff Flexstaff lit le projet", (await rest(S.jwt, `staff_projects?select=id&id=eq.${projectId}`)).data?.length === 1);
check("staff Flexstaff ne peut pas modifier un projet", refused(await patchProject(S, { title: "rls-piraté" })));
check("staff Flexstaff ne peut pas supprimer un projet", refused(await rest(S.jwt, `staff_projects?id=eq.${projectId}`, { method: "DELETE", prefer: "return=representation" })));
check("compte sans rôle Flexstaff ne peut pas modifier un projet", refused(await patchProject(NOROLE, { title: "rls-piraté" })));
check("admin Flexstaff modifie un projet", (await patchProject(ADM, { short_description: "Modifiée" })).data?.[0]?.short_description === "Modifiée");
check("super admin modifie un projet", (await patchProject(superAdmin, { long_description: "Par le super admin" })).data?.[0]?.long_description === "Par le super admin");
const badPatch = await patchProject(ADM, { ticketing_open: "2027-01-01" });
check("modification refusée quand la billetterie ouvrirait après sa fermeture", badPatch.status === 400 && badPatch.data?.code === "23514", JSON.stringify(badPatch));
check("admin Flexstaff ne peut pas changer la date de création d'un projet (droit de colonne)", privilegeError(await patchProject(ADM, { created_at: "2020-01-01T00:00:00Z" })));

const newTask = (who, title) => rest(who.jwt, "staff_tasks", { method: "POST", body: { project_id: projectId, title }, prefer: "return=representation" });
const t1 = await newTask(S, "rls-tache-staff");
check("staff Flexstaff ajoute une tâche", t1.status === 201, JSON.stringify(t1));
const task1 = t1.data?.[0]?.id;
const task2 = (await newTask(ADM, "rls-tache-admin")).data?.[0]?.id;
check("admin Flexstaff ajoute une tâche", Boolean(task2));
check("compte sans rôle Flexstaff ne peut pas ajouter de tâche", refused(await newTask(NOROLE, "rls-pirate")));
check("visiteur ne peut pas ajouter de tâche", refused(await newTask({ jwt: ANON }, "rls-pirate")));

const assign = (who, taskId, userId) => rest(who.jwt, "staff_task_assignees", { method: "POST", body: { task_id: taskId, user_id: userId }, prefer: "return=representation" });
const unassign = (who, taskId, userId) => rest(who.jwt, `staff_task_assignees?task_id=eq.${taskId}&user_id=eq.${userId}`, { method: "DELETE", prefer: "return=representation" });
check("staff Flexstaff s'inscrit sur une tâche", (await assign(S, task1, S.id)).status === 201);
check("staff Flexstaff ne peut pas inscrire quelqu'un d'autre", refused(await assign(S, task2, ADM.id)));
check("admin Flexstaff inscrit un membre de l'équipe", (await assign(ADM, task2, ADM.id)).status === 201 && (await assign(ADM, task1, ADM.id)).status === 201);
check("admin Flexstaff inscrit un super admin (membre de toutes les équipes)", (await assign(ADM, task2, superAdmin.id)).status === 201);
check("admin Flexstaff ne peut pas inscrire un compte hors de l'équipe", refused(await assign(ADM, task2, NOROLE.id)));
check("compte sans rôle Flexstaff ne peut pas s'inscrire", refused(await assign(NOROLE, task1, NOROLE.id)));
check("staff Flexstaff ne peut pas modifier une inscription (aucun droit de mise à jour)", (await rest(S.jwt, `staff_task_assignees?task_id=eq.${task1}&user_id=eq.${S.id}`, { method: "PATCH", body: { user_id: ADM.id } })).status >= 400);

const patchTask = (who, id, body) => rest(who.jwt, `staff_tasks?id=eq.${id}`, { method: "PATCH", body, prefer: "return=representation" });
check("staff Flexstaff inscrit coche sa tâche", (await patchTask(S, task1, { done: true })).data?.[0]?.done === true);
check("staff Flexstaff inscrit décoche sa tâche", (await patchTask(S, task1, { done: false })).data?.[0]?.done === false);
check("staff Flexstaff ne peut pas cocher une tâche où il n'est pas inscrit", refused(await patchTask(S, task2, { done: true })));
const renamed = await patchTask(S, task1, { title: "rls-piraté" });
check("staff Flexstaff ne peut pas renommer une tâche, même la sienne", renamed.status === 403 && renamed.data?.code === "PT403", JSON.stringify(renamed));
const renamedDone = await patchTask(S, task1, { done: true, due_date: "2026-12-01" });
check("staff Flexstaff ne peut pas changer l'échéance en cochant", renamedDone.status === 403, JSON.stringify(renamedDone));
check("staff Flexstaff ne peut pas déplacer une tâche vers un autre projet (droit de colonne)", privilegeError(await patchTask(S, task1, { project_id: projectId })));
check("staff Flexstaff ne peut pas supprimer une tâche, même la sienne", refused(await rest(S.jwt, `staff_tasks?id=eq.${task1}`, { method: "DELETE", prefer: "return=representation" })));
check("la tâche du staff est intacte", (await rest(SERVICE, `staff_tasks?select=title,done,due_date&id=eq.${task1}`)).data?.[0]?.title === "rls-tache-staff");
const adminEdit = await patchTask(ADM, task1, { title: "rls-tache-renommee", description: "Détails", due_date: "2026-12-01" });
check("admin Flexstaff modifie une tâche", adminEdit.data?.[0]?.title === "rls-tache-renommee" && adminEdit.data?.[0]?.due_date === "2026-12-01", JSON.stringify(adminEdit));
check("admin Flexstaff coche une tâche", (await patchTask(ADM, task2, { done: true })).data?.[0]?.done === true);
check("compte sans rôle Flexstaff ne peut pas cocher une tâche", refused(await patchTask(NOROLE, task2, { done: false })));

const team2 = await rpc(S.jwt, "staff_team");
check("staff Flexstaff lit l'équipe Flexstaff avec les e-mails", team2.status === 200 && [S.id, ADM.id, superAdmin.id].every((id) => team2.data?.some?.((m) => m.user_id === id && m.email)), JSON.stringify(team2.status));
check("l'équipe Flexstaff ne contient pas les comptes sans rôle", team2.data?.every?.((m) => m.user_id !== NOROLE.id));
check("compte sans rôle Flexstaff ne peut pas appeler staff_team", (await rpc(NOROLE.jwt, "staff_team")).status === 403);
check("visiteur ne peut pas appeler staff_team", (await rpc(ANON, "staff_team")).status >= 400);

check("staff Flexstaff ne peut pas retirer quelqu'un d'autre d'une tâche", refused(await unassign(S, task1, ADM.id)));
check("staff Flexstaff se retire d'une tâche", (await unassign(S, task1, S.id)).data?.length === 1);
check("staff Flexstaff ne peut plus cocher la tâche qu'il a quittée", refused(await patchTask(S, task1, { done: true })));
check("admin Flexstaff retire quelqu'un d'une tâche", (await unassign(ADM, task2, superAdmin.id)).data?.length === 1);

for (const [who, label] of [[{ jwt: ANON }, "visiteur"], [NOROLE, "compte sans rôle Flexstaff"]]) {
  for (const table of ["staff_projects", "staff_tasks", "staff_task_assignees"]) {
    check(`${label} ne lit rien dans ${table}`, refused(await rest(who.jwt, `${table}?select=*`)));
  }
}
check("compte sans rôle Flexstaff ne peut pas supprimer de tâche", refused(await rest(NOROLE.jwt, `staff_tasks?id=eq.${task2}`, { method: "DELETE", prefer: "return=representation" })));

// Rôle retiré : plus aucun accès, et l'ancien membre reste nommé sur ses tâches
await assign(S, task1, S.id);
await rest(SERVICE, `app_roles?user_id=eq.${S.id}&app=eq.flexstaff`, { method: "DELETE" });
check("staff dont le rôle Flexstaff est retiré ne lit plus rien", (await rest(S.jwt, "staff_projects?select=id")).data?.length === 0 && (await rest(S.jwt, "staff_tasks?select=id")).data?.length === 0);
check("staff dont le rôle Flexstaff est retiré ne peut plus cocher sa tâche", refused(await patchTask(S, task1, { done: true })));
const formerTeam = (await rpc(ADM.jwt, "staff_team")).data;
check("un ancien membre encore inscrit apparaît dans staff_team sans rôle", formerTeam?.some?.((m) => m.user_id === S.id && m.role === null), JSON.stringify(formerTeam?.length));

check("admin Flexstaff supprime une tâche", (await rest(ADM.jwt, `staff_tasks?id=eq.${task2}`, { method: "DELETE", prefer: "return=representation" })).data?.length === 1);
check("supprimer la tâche efface ses inscriptions", (await rest(SERVICE, `staff_task_assignees?select=user_id&task_id=eq.${task2}`)).data.length === 0);
check("admin Flexstaff supprime un projet", (await rest(ADM.jwt, `staff_projects?id=eq.${projectId}`, { method: "DELETE", prefer: "return=representation" })).data?.length === 1);
check("supprimer le projet efface ses tâches et inscriptions", (await rest(SERVICE, `staff_tasks?select=id&project_id=eq.${projectId}`)).data.length === 0
  && (await rest(SERVICE, `staff_task_assignees?select=user_id&task_id=eq.${task1}`)).data.length === 0);

// Nettoyage
await rest(SERVICE, "sondage_polls?id=like.rls-*", { method: "DELETE" });
await rest(SERVICE, "projects?slug=like.rls-*", { method: "DELETE" });
await rest(SERVICE, "suite_rate_limits?key=like.rls-*", { method: "DELETE" });
await fetch(`${SB}/storage/v1/object/project-images`, {
  method: "DELETE",
  headers: { apikey: ANON, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" },
  body: JSON.stringify({ prefixes: ["rls-folio.png", "rls-staff.png"] }),
});
await rest(SERVICE, "design_themes?name=like.rls-*", { method: "DELETE" });
await rest(SERVICE, "design_fonts?label=like.rls-*", { method: "DELETE" });
await purgeBoards();
await rest(SERVICE, `app_roles?user_id=in.(${staff.id},${formAdmin.id})&app=eq.flexdesign`, { method: "DELETE" });
await rest(SERVICE, "staff_projects?title=like.rls-*", { method: "DELETE" });
await rest(SERVICE, `app_roles?user_id=in.(${staff.id},${formAdmin.id},${folioAdmin.id})&app=eq.flexstaff`, { method: "DELETE" });
await fetch(`${SB}/storage/v1/object/design-fonts`, {
  method: "DELETE",
  headers: { apikey: ANON, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" },
  body: JSON.stringify({ prefixes: ["rls-font.woff2", "rls-anon.woff2", "rls-staff.woff2", "rls-form.woff2", "rls-image.png"] }),
});

console.log(`\n${failures ? `${failures} échec(s)` : "Tout est passé."}`);
process.exit(failures ? 1 : 0);

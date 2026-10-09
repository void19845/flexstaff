import "server-only";

import { MAX_ANSWER_LENGTH, type PollOption, type RewardCheck, type StaffPoll } from "@/lib/shared/types";
import { HttpError } from "./errors";
import { Db, eq } from "./supabase";

/*
 * Page /staff : remise des récompenses et sondages réservés au staff de Flexform.
 * Lit et écrit directement les tables sondage_* de Flexform (voir supabase/init.sql de Flexform), toujours avec
 * le jeton du compte connecté : la RLS de Flexform décide (lecture des codes et des sondages, remise d'un code,
 * réponse en son propre nom). Jamais avec serviceDb().
 */

// --- Lignes de la base ----------------------------------------------------

interface PollRow {
  id: string;
  kind: "choice" | "text";
  question: string;
  options: PollOption[];
  hub: boolean;
}

interface StaffVoteRow {
  poll_id: string;
  value: string;
}

const ms = (iso: string | null): number | null => (iso ? Date.parse(iso) : null);
const nowIso = (): string => new Date().toISOString();

// --- Récompenses ----------------------------------------------------------

/**
 * Accepte le contenu du QR code (le code seul, ou l'adresse de l'ancienne page staff de Flexform pour les
 * anciens QR codes) ou le code tapé à la main, avec ou sans tirets.
 */
export function normalizeCode(raw: string): string {
  let text = raw.trim();
  try {
    text = new URL(text).searchParams.get("code") ?? "";
  } catch {
    // pas une adresse : c'est le code lui-même
  }
  return text.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 32);
}

interface CodeLookup {
  code: string;
  redeemed_at: string | null;
  poll: { question: string; reward: string } | null;
  participant: { pseudo: string; prenom: string; nom: string; formation: string } | null;
}

/** Ce que voit le staff après un scan (lu avec son propre jeton : la RLS s'applique). */
export async function checkReward(db: Db, rawCode: string): Promise<RewardCheck> {
  const code = normalizeCode(rawCode);
  const row = code
    ? await db.one<CodeLookup>(
        "sondage_reward_codes",
        `select=code,redeemed_at,poll:sondage_polls(question,reward),participant:sondage_participants(pseudo,prenom,nom,formation)&code=${eq(code)}`,
      )
    : null;
  if (!row) return { status: "invalid", code, message: "Code inconnu, ou annulé (sondage remis à zéro ou supprimé)." };
  const person = row.participant ? { ...row.participant } : undefined;
  if (!row.poll?.reward) return { status: "invalid", code, person, message: "Code annulé : la récompense a été retirée de ce sondage." };
  const base = { code, person, reward: row.poll.reward, question: row.poll.question };
  if (row.redeemed_at) return { ...base, status: "used", redeemedAt: ms(row.redeemed_at) };
  return { ...base, status: "valid", redeemedAt: null };
}

/**
 * Valide la remise. La mise à jour ne touche que les codes pas encore remis :
 * si deux membres du staff valident en même temps, un seul réussit.
 */
export async function redeemReward(db: Db, userId: string, rawCode: string): Promise<RewardCheck> {
  const check = await checkReward(db, rawCode);
  if (check.status !== "valid") return check;
  const at = nowIso();
  const rows = await db.update("sondage_reward_codes", `code=${eq(check.code)}&redeemed_at=is.null`, {
    redeemed_at: at,
    redeemed_by: userId || null,
  });
  if (!rows.length) return checkReward(db, check.code);
  return { ...check, status: "done", redeemedAt: Date.parse(at) };
}

// --- Sondages réservés au staff ---------------------------------------------

/** Réponse valide pour ce sondage : un de ses choix, ou un texte de 1 à MAX_ANSWER_LENGTH caractères. */
function checkAnswer(poll: Pick<PollRow, "kind" | "options">, value: string): void {
  if (poll.kind === "choice" && !poll.options.some((o) => o.id === value)) {
    throw new HttpError(400, "Choix invalide");
  }
  if (poll.kind === "text" && (value.length < 1 || value.length > MAX_ANSWER_LENGTH)) {
    throw new HttpError(400, `Ta réponse doit faire entre 1 et ${MAX_ANSWER_LENGTH} caractères`);
  }
}

/** Sondages réservés au staff et ouverts (dans le hub), avec la réponse du compte connecté. */
export async function staffPolls(db: Db, userId: string): Promise<StaffPoll[]> {
  const [rows, mine] = await Promise.all([
    db.select<PollRow>("sondage_polls", "select=id,kind,question,options,hub&staff_only=eq.true&hub=eq.true&order=position.asc,created_at.asc"),
    db.select<StaffVoteRow>("sondage_staff_votes", `select=poll_id,value&user_id=${eq(userId)}`),
  ]);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    question: r.question,
    options: r.options,
    myVote: mine.find((v) => v.poll_id === r.id)?.value ?? null,
  }));
}

/** Enregistre ou remplace la réponse du compte connecté. La RLS refuse aussi tout autre sondage ou compte. */
export async function staffVote(db: Db, userId: string, pollId: string, value: string): Promise<void> {
  const poll = await db.one<PollRow>("sondage_polls", `select=id,kind,question,options,hub&id=${eq(pollId)}&staff_only=eq.true`);
  if (!poll) throw new HttpError(404, "Sondage introuvable");
  if (!poll.hub) throw new HttpError(409, "Le vote est clôturé");
  checkAnswer(poll, value);
  await db.insert(
    "sondage_staff_votes",
    { poll_id: pollId, user_id: userId, value, voted_at: nowIso() },
    { onConflict: "poll_id,user_id", resolution: "merge" },
  );
}

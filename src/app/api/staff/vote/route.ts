import { json, readJson, requireFlexformStaff, route, str } from "@/lib/server/http";
import { staffVote } from "@/lib/server/rewards";

/** Réponse du compte connecté à un sondage réservé au staff : { pollId, value }. */
export const POST = route(async (req) => {
  const { db, userId } = await requireFlexformStaff(req);
  const body = await readJson(req);
  await staffVote(db, userId, str(body.pollId), str(body.value));
  return json({ ok: true });
});

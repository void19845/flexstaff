import { HttpError, json, readJson, requireFlexformStaff, route, str } from "@/lib/server/http";
import { checkReward } from "@/lib/server/rewards";

/** Vérifie un code scanné sans le valider : { code } -> RewardCheck. */
export const POST = route(async (req) => {
  const { db } = await requireFlexformStaff(req);
  const code = str((await readJson(req)).code);
  if (!code) throw new HttpError(400, "Code manquant");
  return json(await checkReward(db, code));
});

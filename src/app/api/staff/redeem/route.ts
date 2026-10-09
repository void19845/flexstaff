import { json, readJson, requireFlexformStaff, route, str } from "@/lib/server/http";
import { redeemReward } from "@/lib/server/rewards";

/** Valide la remise d'une récompense : { code } -> RewardCheck. Un code ne peut être validé qu'une fois. */
export const POST = route(async (req) => {
  const { db, userId } = await requireFlexformStaff(req);
  return json(await redeemReward(db, userId, str((await readJson(req)).code)));
});

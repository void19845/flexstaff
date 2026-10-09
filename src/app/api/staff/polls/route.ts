import { json, requireFlexformStaff, route } from "@/lib/server/http";
import { staffPolls } from "@/lib/server/rewards";

/** Sondages réservés au staff et ouverts, avec la réponse du compte connecté -> StaffPoll[]. */
export const GET = route(async (req) => {
  const { db, userId } = await requireFlexformStaff(req);
  return json(await staffPolls(db, userId));
});

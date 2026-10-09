import { json, readJson, requireFlexstaff, route } from "@/lib/server/http";
import { addAssignee, removeAssignee } from "@/lib/server/planning";

/** S'inscrire sur une tâche (userId absent), ou y inscrire un membre de l'équipe (admins) : { taskId, userId? }. */
export const POST = route(async (req) => {
  const ctx = await requireFlexstaff(req);
  await addAssignee(ctx, await readJson(req));
  return json({ ok: true });
});

/** Se retirer d'une tâche (userId absent), ou en retirer quelqu'un (admins) : { taskId, userId? }. */
export const DELETE = route(async (req) => {
  const ctx = await requireFlexstaff(req);
  await removeAssignee(ctx, await readJson(req));
  return json({ ok: true });
});

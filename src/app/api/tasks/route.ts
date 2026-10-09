import { json, readJson, requireFlexstaff, route } from "@/lib/server/http";
import { createTask, deleteTask, updateTask } from "@/lib/server/planning";

/** Ajoute une tâche à un projet (toute l'équipe) : { projectId, title, description, dueDate } -> { id }. */
export const POST = route(async (req) => {
  const ctx = await requireFlexstaff(req);
  return json(await createTask(ctx, await readJson(req)));
});

/** Modifie une tâche : { id, title?, description?, dueDate? } (admins), { id, done } (admins et personnes inscrites). */
export const PATCH = route(async (req) => {
  const ctx = await requireFlexstaff(req);
  await updateTask(ctx, await readJson(req));
  return json({ ok: true });
});

/** Supprime une tâche (admins) : { id }. */
export const DELETE = route(async (req) => {
  const ctx = await requireFlexstaff(req);
  await deleteTask(ctx, await readJson(req));
  return json({ ok: true });
});

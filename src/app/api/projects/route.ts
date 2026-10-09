import { json, readJson, requireFlexstaff, route } from "@/lib/server/http";
import { createProject, deleteProject, getPlanning, getProject, updateProject } from "@/lib/server/planning";

/** Calendrier : GET /api/projects -> Planning ; GET /api/projects?id=<id> -> ProjectDetail. */
export const GET = route(async (req) => {
  const ctx = await requireFlexstaff(req);
  const id = new URL(req.url).searchParams.get("id");
  return json(id === null ? await getPlanning(ctx) : await getProject(ctx, id));
});

/** Crée un projet (admins) : ProjectFields -> { id }. */
export const POST = route(async (req) => {
  const ctx = await requireFlexstaff(req);
  return json(await createProject(ctx, await readJson(req)));
});

/** Modifie un projet (admins) : { id, ...ProjectFields }. */
export const PATCH = route(async (req) => {
  const ctx = await requireFlexstaff(req);
  await updateProject(ctx, await readJson(req));
  return json({ ok: true });
});

/** Supprime un projet et ses tâches (admins) : { id }. */
export const DELETE = route(async (req) => {
  const ctx = await requireFlexstaff(req);
  await deleteProject(ctx, await readJson(req));
  return json({ ok: true });
});

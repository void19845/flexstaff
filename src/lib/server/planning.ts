import "server-only";

import {
  MAX_LONG_DESCRIPTION,
  MAX_PROJECT_TITLE,
  MAX_SHORT_DESCRIPTION,
  MAX_TASK_DESCRIPTION,
  MAX_TASK_TITLE,
  type Planning,
  type PlanningMember,
  type Project,
  type ProjectDetail,
  type Task,
} from "@/lib/shared/planning";
import { HttpError } from "./errors";
import { str, type FlexstaffContext } from "./http";
import { eq } from "./supabase";

/*
 * Calendrier de l'équipe Flexstaff : projets (un par événement), tâches et inscriptions (tables staff_*).
 * Tout passe par ctx.db (jeton du compte connecté) : la RLS et la garde staff_tasks_guard de la base décident.
 * Le serveur revérifie les saisies et le rôle pour renvoyer un message clair, sans jamais élargir les droits.
 */

interface ProjectRow {
  id: string;
  title: string;
  short_description: string;
  long_description: string;
  event_date: string;
  communication_start: string;
  ticketing_open: string;
  ticketing_close: string;
}

interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  due_date: string | null;
  done: boolean;
  staff_task_assignees?: { user_id: string }[];
}

const ADMINS_ONLY = "Réservé aux admins de Flexstaff.";
const PROJECT_NOT_FOUND = "Projet introuvable.";
const TASK_NOT_FOUND = "Tâche introuvable.";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PROJECT_COLUMNS = "id,title,short_description,long_description,event_date,communication_start,ticketing_open,ticketing_close";

// --- Validation des entrées ------------------------------------------------

function requireAdminRole(ctx: FlexstaffContext): void {
  if (ctx.role !== "admin") throw new HttpError(403, ADMINS_ONLY);
}

function parseId(value: unknown, label: string): string {
  const id = str(value).toLowerCase();
  if (!UUID_RE.test(id)) throw new HttpError(400, `Identifiant de ${label} invalide.`);
  return id;
}

function parseText(value: unknown, label: string, max: number, required: boolean): string {
  const text = str(value);
  if (required && !text) throw new HttpError(400, `${label} : champ obligatoire.`);
  if (text.length > max) throw new HttpError(400, `${label} : ${max} caractères maximum.`);
  return text;
}

/** Date réelle au format AAAA-MM-JJ (le 2025-02-30 est refusé). */
function parseDate(value: unknown, label: string): string {
  const date = str(value);
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!DATE_RE.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new HttpError(400, `${label} : date invalide.`);
  }
  return date;
}

/** Champs d'un projet, tous obligatoires, avec les mêmes contraintes d'ordre que la base. */
function parseProject(body: Record<string, unknown>): Omit<ProjectRow, "id"> {
  const row = {
    title: parseText(body.title, "Titre", MAX_PROJECT_TITLE, true),
    short_description: parseText(body.shortDescription, "Description courte", MAX_SHORT_DESCRIPTION, true),
    long_description: parseText(body.longDescription, "Description longue", MAX_LONG_DESCRIPTION, true),
    event_date: parseDate(body.eventDate, "Date de l'événement"),
    communication_start: parseDate(body.communicationStart, "Début de la communication"),
    ticketing_open: parseDate(body.ticketingOpen, "Ouverture de la billetterie"),
    ticketing_close: parseDate(body.ticketingClose, "Fermeture de la billetterie"),
  };
  // Dates AAAA-MM-JJ : l'ordre des chaînes est celui des dates
  if (row.ticketing_open > row.ticketing_close) throw new HttpError(400, "La billetterie doit ouvrir avant de fermer.");
  if (row.communication_start > row.event_date) throw new HttpError(400, "La communication doit commencer avant l'événement.");
  return row;
}

function parseDueDate(value: unknown): string | null {
  return value === null || value === undefined || value === "" ? null : parseDate(value, "Échéance");
}

// --- Lecture -----------------------------------------------------------------

function toProject(row: ProjectRow, tasks: { done: boolean }[]): Project {
  return {
    id: row.id,
    title: row.title,
    shortDescription: row.short_description,
    longDescription: row.long_description,
    eventDate: row.event_date,
    communicationStart: row.communication_start,
    ticketingOpen: row.ticketing_open,
    ticketingClose: row.ticketing_close,
    tasks: tasks.length,
    tasksDone: tasks.filter((t) => t.done).length,
  };
}

export async function getPlanning(ctx: FlexstaffContext): Promise<Planning> {
  const [rows, tasks] = await Promise.all([
    ctx.db.select<ProjectRow>("staff_projects", `select=${PROJECT_COLUMNS}&order=event_date.asc,title.asc`),
    ctx.db.select<{ project_id: string; done: boolean }>("staff_tasks", "select=project_id,done"),
  ]);
  return { role: ctx.role, projects: rows.map((row) => toProject(row, tasks.filter((t) => t.project_id === row.id))) };
}

export async function getProject(ctx: FlexstaffContext, idParam: unknown): Promise<ProjectDetail> {
  const id = parseId(idParam, "projet");
  const [row, taskRows, team] = await Promise.all([
    ctx.db.one<ProjectRow>("staff_projects", `select=${PROJECT_COLUMNS}&id=${eq(id)}`),
    ctx.db.select<TaskRow>(
      "staff_tasks",
      `select=id,project_id,title,description,due_date,done,staff_task_assignees(user_id)&project_id=${eq(id)}&order=due_date.asc.nullslast,created_at.asc`,
    ),
    ctx.db.rpc<{ user_id: string; email: string; role: PlanningMember["role"] }[]>("staff_team"),
  ]);
  if (!row) throw new HttpError(404, PROJECT_NOT_FOUND);
  const tasks: Task[] = taskRows.map((t) => ({
    id: t.id,
    title: t.title,
    description: t.description,
    dueDate: t.due_date,
    done: t.done,
    assignees: (t.staff_task_assignees ?? []).map((a) => a.user_id),
  }));
  return {
    role: ctx.role,
    me: ctx.userId,
    project: toProject(row, taskRows),
    tasks,
    members: team.map((m) => ({ userId: m.user_id, email: m.email, role: m.role })),
  };
}

// --- Projets (admins) ---------------------------------------------------------

export async function createProject(ctx: FlexstaffContext, body: Record<string, unknown>): Promise<{ id: string }> {
  requireAdminRole(ctx);
  const [row] = await ctx.db.insert<{ id: string }>("staff_projects", parseProject(body));
  return { id: row.id };
}

export async function updateProject(ctx: FlexstaffContext, body: Record<string, unknown>): Promise<void> {
  requireAdminRole(ctx);
  const id = parseId(body.id, "projet");
  const rows = await ctx.db.update("staff_projects", `id=${eq(id)}`, parseProject(body));
  if (!rows.length) throw new HttpError(404, PROJECT_NOT_FOUND);
}

export async function deleteProject(ctx: FlexstaffContext, body: Record<string, unknown>): Promise<void> {
  requireAdminRole(ctx);
  await ctx.db.remove("staff_projects", `id=${eq(parseId(body.id, "projet"))}`);
}

// --- Tâches -------------------------------------------------------------------

/** Ajout d'une tâche : toute l'équipe. */
export async function createTask(ctx: FlexstaffContext, body: Record<string, unknown>): Promise<{ id: string }> {
  const projectId = parseId(body.projectId, "projet");
  const row = {
    project_id: projectId,
    title: parseText(body.title, "Titre", MAX_TASK_TITLE, true),
    description: parseText(body.description, "Description", MAX_TASK_DESCRIPTION, false),
    due_date: parseDueDate(body.dueDate),
  };
  if (!(await ctx.db.one("staff_projects", `select=id&id=${eq(projectId)}`))) throw new HttpError(404, PROJECT_NOT_FOUND);
  const [created] = await ctx.db.insert<{ id: string }>("staff_tasks", row);
  return { id: created.id };
}

/**
 * Modification d'une tâche : seuls les champs envoyés changent. Titre, description et échéance : admins ;
 * done : admins et personnes inscrites sur la tâche.
 */
export async function updateTask(ctx: FlexstaffContext, body: Record<string, unknown>): Promise<void> {
  const id = parseId(body.id, "tâche");
  const patch: Record<string, unknown> = {};
  if (body.title !== undefined) patch.title = parseText(body.title, "Titre", MAX_TASK_TITLE, true);
  if (body.description !== undefined) patch.description = parseText(body.description, "Description", MAX_TASK_DESCRIPTION, false);
  if (body.dueDate !== undefined) patch.due_date = parseDueDate(body.dueDate);
  if (Object.keys(patch).length) requireAdminRole(ctx);
  if (body.done !== undefined) {
    if (typeof body.done !== "boolean") throw new HttpError(400, "État de la tâche invalide.");
    patch.done = body.done;
  }
  if (!Object.keys(patch).length) throw new HttpError(400, "Rien à modifier.");

  if (!(await ctx.db.one("staff_tasks", `select=id&id=${eq(id)}`))) throw new HttpError(404, TASK_NOT_FOUND);
  // La RLS filtre sans erreur : aucune ligne modifiée = pas inscrit sur la tâche
  const rows = await ctx.db.update("staff_tasks", `id=${eq(id)}`, patch);
  if (!rows.length) throw new HttpError(403, "Inscris-toi sur la tâche pour la cocher.");
}

export async function deleteTask(ctx: FlexstaffContext, body: Record<string, unknown>): Promise<void> {
  requireAdminRole(ctx);
  await ctx.db.remove("staff_tasks", `id=${eq(parseId(body.id, "tâche"))}`);
}

// --- Inscriptions -------------------------------------------------------------

/** Personne visée : le compte connecté si userId est absent ; quelqu'un d'autre seulement pour un admin. */
function parseAssignment(ctx: FlexstaffContext, body: Record<string, unknown>): { taskId: string; userId: string } {
  const taskId = parseId(body.taskId, "tâche");
  const userId = body.userId === undefined || body.userId === null ? ctx.userId : parseId(body.userId, "membre");
  if (userId !== ctx.userId) requireAdminRole(ctx);
  return { taskId, userId };
}

/** S'inscrire sur une tâche, ou y inscrire un membre de l'équipe (admins). Déjà inscrit : rien ne change. */
export async function addAssignee(ctx: FlexstaffContext, body: Record<string, unknown>): Promise<void> {
  const { taskId, userId } = parseAssignment(ctx, body);
  const [task, team] = await Promise.all([
    ctx.db.one("staff_tasks", `select=id&id=${eq(taskId)}`),
    ctx.db.rpc<{ user_id: string; role: PlanningMember["role"] }[]>("staff_team"),
  ]);
  if (!task) throw new HttpError(404, TASK_NOT_FOUND);
  if (!team.some((m) => m.user_id === userId && m.role)) throw new HttpError(400, "Ce compte n'est pas dans l'équipe Flexstaff.");
  await ctx.db.insert("staff_task_assignees", { task_id: taskId, user_id: userId }, { onConflict: "task_id,user_id", resolution: "ignore" });
}

/** Se retirer d'une tâche, ou en retirer quelqu'un (admins). */
export async function removeAssignee(ctx: FlexstaffContext, body: Record<string, unknown>): Promise<void> {
  const { taskId, userId } = parseAssignment(ctx, body);
  await ctx.db.remove("staff_task_assignees", `task_id=${eq(taskId)}&user_id=${eq(userId)}`);
}

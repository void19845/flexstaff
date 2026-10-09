/**
 * Contrat entre l'API du calendrier (src/app/api/projects, src/app/api/tasks) et l'interface (src/components).
 * Réservé à l'équipe Flexstaff (rôle dans l'appli flexstaff, ou super admin). Les droits sont ceux de la base
 * (tables staff_*) : voir la fin de supabase/init.sql.
 *
 *   GET    /api/projects                                   -> Planning
 *   GET    /api/projects?id=<id>                           -> ProjectDetail
 *   POST   /api/projects        ProjectFields              -> { id }        admins
 *   PATCH  /api/projects        { id, ...ProjectFields }   -> { ok: true }  admins
 *   DELETE /api/projects        { id }                     -> { ok: true }  admins (ses tâches avec)
 *   POST   /api/tasks           { projectId, title, description, dueDate } -> { id }   équipe
 *   PATCH  /api/tasks           { id, title?, description?, dueDate?, done? }           title, description,
 *                                                          dueDate : admins ; done : admins et personnes inscrites
 *   DELETE /api/tasks           { id }                                                  admins
 *   POST   /api/tasks/assignees { taskId, userId? }        s'inscrire (userId absent ou le sien), ou inscrire
 *                                                          un membre de l'équipe (admins)
 *   DELETE /api/tasks/assignees { taskId, userId? }        se retirer, ou retirer quelqu'un (admins)
 * Erreurs : { error: string } avec le code HTTP (400 saisie, 401 non connecté, 403 droits, 404 introuvable).
 */
import type { Role } from "./types";

/** Dates au format AAAA-MM-JJ (jour seul, sans heure) */
export interface ProjectFields {
  title: string;
  shortDescription: string;
  longDescription: string;
  eventDate: string;
  communicationStart: string;
  ticketingOpen: string;
  ticketingClose: string;
}

export interface Project extends ProjectFields {
  id: string;
  /** Nombre de tâches, et de tâches faites */
  tasks: number;
  tasksDone: number;
}

/** GET /api/projects : tous les projets, triés par date d'événement */
export interface Planning {
  /** Rôle du compte connecté dans l'équipe Flexstaff, relu dans la base */
  role: Role;
  projects: Project[];
}

/** Membre de l'équipe Flexstaff. role null : ancien membre encore inscrit sur une tâche. */
export interface PlanningMember {
  userId: string;
  email: string;
  role: Role | "super" | null;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  /** AAAA-MM-JJ, ou null sans échéance */
  dueDate: string | null;
  done: boolean;
  /** Identifiants des personnes inscrites */
  assignees: string[];
}

/** GET /api/projects?id=<id> */
export interface ProjectDetail {
  role: Role;
  /** Identifiant du compte connecté */
  me: string;
  project: Project;
  tasks: Task[];
  members: PlanningMember[];
}

export const MAX_PROJECT_TITLE = 120;
export const MAX_SHORT_DESCRIPTION = 300;
export const MAX_LONG_DESCRIPTION = 4000;
export const MAX_TASK_TITLE = 120;
export const MAX_TASK_DESCRIPTION = 2000;

/**
 * Contrat entre l'API de Flexstaff (src/app/api) et l'interface (src/components).
 * Les droits sont ceux de la base (tables suite_super_admins, suite_apps, app_roles) : voir supabase/init.sql.
 */

/** Rôle dans une appli de la suite */
export type Role = "admin" | "staff";

export interface SuiteApp {
  app: string;
  name: string;
}

/** GET /api/auth/me et réponse de POST /api/auth/login */
export interface Me {
  email: string;
  superAdmin: boolean;
  /** Applis dont le compte est admin (toutes pour un super admin), triées par nom */
  apps: SuiteApp[];
  /** Accès à /staff : rôle admin ou staff dans Flexform */
  staffPage: boolean;
}

/** Membre de l'équipe d'une appli. role "super" : super admin de la suite, défini en SQL, non modifiable ici. */
export interface Member {
  userId: string;
  email: string;
  role: Role | "super";
  /** Date d'ajout (ms) */
  since: number;
  /** Le compte connecté */
  me: boolean;
}

/** GET /api/team?app=<app> */
export interface Team {
  app: string;
  name: string;
  members: Member[];
}

/** POST /api/team { app, email, role } : ajoute un membre (compte créé s'il n'existe pas) ou change son rôle. */
export interface AddMemberResult {
  created: boolean;
  /** Mot de passe provisoire du compte créé, affiché une seule fois */
  temporaryPassword?: string;
}

/**
 * POST /api/team/password { userId, password? } : change le mot de passe d'un membre (tous ses rôles doivent être
 * dans des applis administrées par le compte connecté). password vide : un mot de passe est généré.
 */
export interface ResetPasswordResult {
  email: string;
  /** Mot de passe généré, affiché une seule fois (absent si l'admin l'a saisi) */
  temporaryPassword?: string;
}

/**
 * Autres routes (réponse { ok: true }) :
 *   POST /api/team/role     { app, userId, role: Role | null }   promouvoir, rétrograder, retirer (null)
 *   POST /api/team/handover { app, userId }                      transmettre le rôle admin : userId devient
 *                                                                admin, le compte connecté devient staff
 *                                                                (sauf super admin, qui le reste)
 *   POST /api/auth/password { current, password }                changer son propre mot de passe
 *   POST /api/auth/logout
 * Erreurs : { error: string } avec le code HTTP (401 non connecté, 403 droits, 404, 409 conflit, 429).
 */
export const MAX_EMAIL_LENGTH = 254;

// --- Page /staff : récompenses et sondages réservés au staff de Flexform (tables sondage_* de Flexform) ---

/** Longueur maximale d'une réponse libre (la même que dans Flexform) */
export const MAX_ANSWER_LENGTH = 280;

export interface PollOption {
  id: string;
  label: string;
}

/**
 * POST /api/staff/check { code } : vérifie un code scanné sans le valider.
 * POST /api/staff/redeem { code } : valide la remise ; un code ne peut être validé qu'une fois.
 */
export interface RewardCheck {
  status: "valid" | "done" | "used" | "invalid";
  code: string;
  message?: string;
  reward?: string;
  question?: string;
  person?: { pseudo: string; prenom: string; nom: string; formation: string };
  redeemedAt?: number | null;
}

/**
 * GET /api/staff/polls : sondages réservés au staff et ouverts, avec la réponse du compte connecté.
 * POST /api/staff/vote { pollId, value } : répond ou change sa réponse (identifiant du choix, ou texte).
 */
export interface StaffPoll {
  id: string;
  kind: "choice" | "text";
  question: string;
  options: PollOption[];
  myVote: string | null;
}
/** Longueur d'un mot de passe choisi (72 : limite de bcrypt, utilisé par Supabase Auth) */
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 72;

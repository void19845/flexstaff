import { json, requireAccount, route } from "@/lib/server/http";

/**
 * Compte connecté, applis qu'il administre et accès à /staff
 * (401 si personne n'est connecté, 403 s'il n'administre plus rien et n'a plus de rôle dans Flexform).
 */
export const GET = route(async (req) => {
  return json(await requireAccount(req));
});

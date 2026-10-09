import { changePassword, json, readJson, requireAccount, route } from "@/lib/server/http";

/** Change le mot de passe du compte connecté : { current, password }. 400 si l'actuel est faux (la session reste ouverte). */
export const POST = route(async (req) => {
  const ctx = await requireAccount(req);
  const body = await readJson(req);
  await changePassword(req, ctx, body.current, body.password);
  return json({ ok: true });
});

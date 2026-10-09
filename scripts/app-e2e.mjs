/**
 * Test de bout en bout de l'appli Flexstaff (routes HTTP), contre la base LOCALE et l'appli lancée en local.
 * Crée puis supprime un compte de test ; remet les rôles des comptes de test comme au départ.
 * Page /staff : crée puis supprime ses propres données dans les tables sondage_* de Flexform.
 *
 *   node --env-file=.env scripts/app-e2e.mjs [adresse, défaut http://localhost:8786]
 */
const APP = process.argv[2] ?? "http://localhost:8786";
const { SUPABASE_URL: SB, SUPABASE_SERVICE_ROLE_KEY: SERVICE } = process.env;
if (!SB?.includes("127.0.0.1") && !SB?.includes("localhost")) {
  console.error("Refusé : SUPABASE_URL ne pointe pas vers une base locale.");
  process.exit(1);
}
const env = process.env;
const NEW_EMAIL = "e2e-nouveau@test.local";

let failures = 0;
function check(label, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` -> ${detail}` : ""}`);
}

/** Client HTTP avec ses propres cookies, comme un navigateur. */
function browser() {
  const jar = new Map();
  return async (path, { method = "GET", body } = {}) => {
    const res = await fetch(APP + path, {
      method,
      headers: { "Content-Type": "application/json", cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const [k, ...v] = pair.split("=");
      if (/Max-Age=0/.test(c)) jar.delete(k);
      else jar.set(k, v.join("="));
    }
    const data = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
    return { status: res.status, data, cookies: jar.size };
  };
}

const admin = (path, init) => fetch(`${SB}${path}`, { ...init, headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json", ...init?.headers } });

async function deleteUser(email) {
  const { users } = await (await admin("/auth/v1/admin/users?per_page=200")).json();
  const u = users.find((x) => x.email === email);
  if (u) await admin(`/auth/v1/admin/users/${u.id}`, { method: "DELETE" });
}

/** Accès direct à la base (PostgREST) avec la clé service ou un jeton de compte. */
async function rest(bearer, path, { method = "GET", body, prefer } = {}) {
  const res = await fetch(`${SB}/rest/v1/${path}`, {
    method,
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

const login = async (who, email, password) => who("/api/auth/login", { method: "POST", body: { email, password } });
const roleIn = (team, email) => team.data.members?.find((m) => m.email === email)?.role;

await deleteUser(NEW_EMAIL);

console.log("\n# Connexion");
const staff = browser();
const formAdmin = browser();
const folioAdmin = browser();
const superAdmin = browser();
const r0 = await login(staff, env.TEST_STAFF_EMAIL, env.TEST_STAFF_PASSWORD);
check("un staff Flexform (admin d'aucune appli) se connecte, pour /staff seulement", r0.status === 200 && r0.data.staffPage === true && r0.data.apps?.length === 0, JSON.stringify(r0.data));
check("un staff Flexform ne peut pas voir l'équipe Flexform", (await staff("/api/team?app=flexform")).status === 403);
check("un staff Flexform ne peut pas ajouter de membre", (await staff("/api/team", { method: "POST", body: { app: "flexform", email: NEW_EMAIL, role: "admin" } })).status === 403);
const staffMe = await staff("/api/auth/me");
check("/api/auth/me d'un staff Flexform : accès à /staff, aucune appli", staffMe.status === 200 && staffMe.data.staffPage === true && staffMe.data.apps?.length === 0, JSON.stringify(staffMe.data));
check("mauvais mot de passe refusé", (await login(browser(), env.TEST_ADMIN_EMAIL, "nope")).status === 401);
check("sans connexion : 401", (await browser()("/api/team?app=flexform")).status === 401);
const r1 = await login(formAdmin, env.TEST_ADMIN_EMAIL, env.TEST_ADMIN_PASSWORD);
check("admin Flexform connecté, appli flexform seulement", r1.status === 200 && r1.data.apps?.map((a) => a.app).join() === "flexform" && r1.data.superAdmin === false && r1.data.staffPage === true, JSON.stringify(r1.data));
const rFolio = await login(folioAdmin, env.TEST_FOLIO_EMAIL, env.TEST_FOLIO_PASSWORD);
check("admin Flexfolio connecté, sans accès à /staff", rFolio.status === 200 && rFolio.data.staffPage === false, JSON.stringify(rFolio.data));
const r2 = await login(superAdmin, env.TEST_SUPER_EMAIL, env.TEST_SUPER_PASSWORD);
check("super admin : toutes les applis", r2.data.superAdmin === true && r2.data.apps?.length >= 2, JSON.stringify(r2.data));
check("/api/auth/me", (await formAdmin("/api/auth/me")).data.email === env.TEST_ADMIN_EMAIL);

console.log("\n# Équipe");
const team = await formAdmin("/api/team?app=flexform");
check("équipe Flexform : admin, staff et super admin", roleIn(team, env.TEST_ADMIN_EMAIL) === "admin" && roleIn(team, env.TEST_STAFF_EMAIL) === "staff" && roleIn(team, env.TEST_SUPER_EMAIL) === "super", JSON.stringify(team.data));
check("« toi » sur son propre compte", team.data.members?.find((m) => m.email === env.TEST_ADMIN_EMAIL)?.me === true);
check("admin Flexform refusé sur l'équipe Flexfolio", (await formAdmin("/api/team?app=flexfolio")).status === 403);
check("admin Flexfolio refusé sur l'équipe Flexform", (await folioAdmin("/api/team?app=flexform")).status === 403);
const staffId = team.data.members?.find((m) => m.email === env.TEST_STAFF_EMAIL)?.userId;
const superId = team.data.members?.find((m) => m.role === "super")?.userId;
const formAdminId = team.data.members?.find((m) => m.me)?.userId;

console.log("\n# Page /staff : récompenses de Flexform");
// Données de test dans les tables de Flexform, créées avec la clé service et supprimées à la fin
const REWARD_POLL = "e2e-flexstaff-reward";
const STAFF_POLL = "e2e-flexstaff-staff";
const CODE = "FLEXSTAFFE2E";
const cleanStaffData = async () => {
  await rest(SERVICE, `sondage_polls?id=in.(${REWARD_POLL},${STAFF_POLL})`, { method: "DELETE" });
  await rest(SERVICE, "sondage_participants?pseudo=eq.e2e-flexstaff", { method: "DELETE" });
};
await cleanStaffData();
const options = [{ id: "0", label: "Oui" }, { id: "1", label: "Non" }];
await rest(SERVICE, "sondage_polls", {
  method: "POST",
  body: [
    { id: REWARD_POLL, kind: "choice", question: "Sondage e2e Flexstaff", options, reward: "1 café e2e", staff_only: false, hub: false },
    { id: STAFF_POLL, kind: "choice", question: "Dispo pour la réunion staff ?", options, reward: "", staff_only: true, hub: true },
  ],
});
const person = (await rest(SERVICE, "sondage_participants", {
  method: "POST",
  body: { pseudo: "e2e-flexstaff", prenom: "Léa", nom: "Martin", formation: "BUT Info 2", active: false },
  prefer: "return=representation",
})).data[0];
const created = await rest(SERVICE, "sondage_reward_codes", { method: "POST", body: { code: CODE, poll_id: REWARD_POLL, participant_id: person?.id } });
check("données de test créées dans les tables de Flexform", created.status === 201, `${created.status} ${JSON.stringify(created.data)}`);

const page = await fetch(`${APP}/staff`);
check("page /staff : rendue, caméra autorisée, CSP présente", page.status === 200 && page.headers.get("permissions-policy") === "camera=(self)" && /script-src/.test(page.headers.get("content-security-policy") ?? ""),
  `${page.status} ${page.headers.get("permissions-policy")}`);
const staffRoutes = [
  ["POST", "/api/staff/check", { code: CODE }],
  ["POST", "/api/staff/redeem", { code: CODE }],
  ["GET", "/api/staff/polls"],
  ["POST", "/api/staff/vote", { pollId: STAFF_POLL, value: "0" }],
];
for (const [method, path, body] of staffRoutes) {
  check(`un visiteur non connecté ne peut pas appeler ${path} (401)`, (await browser()(path, { method, body })).status === 401);
  check(`un compte sans rôle dans Flexform ne peut pas appeler ${path} (403)`, (await folioAdmin(path, { method, body })).status === 403);
}
const folioJwt = (await (await fetch(`${SB}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: env.SUPABASE_ANON_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ email: env.TEST_FOLIO_EMAIL, password: env.TEST_FOLIO_PASSWORD }) })).json()).access_token;
check("un compte sans rôle dans Flexform ne lit aucun code (accès direct à la base)", (await rest(folioJwt, `sondage_reward_codes?select=code&code=eq.${CODE}`)).data?.length === 0);
const folioRedeem = await rest(folioJwt, `sondage_reward_codes?code=eq.${CODE}`, { method: "PATCH", body: { redeemed_at: new Date().toISOString() }, prefer: "return=representation" });
check("un compte sans rôle dans Flexform ne peut pas valider une remise (accès direct à la base)", folioRedeem.status >= 400 || folioRedeem.data.length === 0, `${folioRedeem.status}`);

const oldQr = await staff("/api/staff/check", { method: "POST", body: { code: `http://localhost:8787/staff?code=${CODE}` } });
check("scan d'un ancien QR (adresse de Flexform) : valide, avec le nom", oldQr.data.status === "valid" && oldQr.data.person?.nom === "Martin" && oldQr.data.reward === "1 café e2e", JSON.stringify(oldQr.data));
check("scan du code seul : valide", (await staff("/api/staff/check", { method: "POST", body: { code: CODE } })).data.status === "valid");
check("code vide refusé (400)", (await staff("/api/staff/check", { method: "POST", body: { code: " " } })).status === 400);
check("code inconnu : invalide", (await staff("/api/staff/check", { method: "POST", body: { code: "ZZZZZZZZZZZZ" } })).data.status === "invalid");
const [ra, rb] = await Promise.all([
  staff("/api/staff/redeem", { method: "POST", body: { code: CODE } }),
  formAdmin("/api/staff/redeem", { method: "POST", body: { code: CODE.toLowerCase().replace(/(.{4})/g, "$1-") } }),
]);
check("double validation simultanée (staff et admin) : une seule réussit", [ra.data.status, rb.data.status].sort().join() === "done,used", `${ra.data.status} ${rb.data.status}`);
check("ensuite : déjà utilisée", (await staff("/api/staff/check", { method: "POST", body: { code: CODE } })).data.status === "used");
const redeemedBy = (await rest(SERVICE, `sondage_reward_codes?select=redeemed_by&code=eq.${CODE}`)).data[0]?.redeemed_by;
check("remise enregistrée au nom de celui qui l'a validée", redeemedBy === (ra.data.status === "done" ? staffId : formAdminId), `${redeemedBy}`);

console.log("\n# Page /staff : sondages réservés au staff");
const staffPollsNow = (await staff("/api/staff/polls")).data;
check("le staff voit le sondage staff ouvert, sans réponse", staffPollsNow.some?.((p) => p.id === STAFF_POLL && p.myVote === null), JSON.stringify(staffPollsNow));
check("un sondage normal n'est pas dans la liste", !staffPollsNow.some?.((p) => p.id === REWARD_POLL));
check("le staff répond", (await staff("/api/staff/vote", { method: "POST", body: { pollId: STAFF_POLL, value: "1" } })).status === 200);
check("le staff change sa réponse", (await staff("/api/staff/vote", { method: "POST", body: { pollId: STAFF_POLL, value: "0" } })).status === 200);
check("l'admin Flexform répond aussi", (await formAdmin("/api/staff/vote", { method: "POST", body: { pollId: STAFF_POLL, value: "1" } })).status === 200);
check("le super admin répond aussi", (await superAdmin("/api/staff/vote", { method: "POST", body: { pollId: STAFF_POLL, value: "1" } })).status === 200);
check("le staff retrouve sa réponse", (await staff("/api/staff/polls")).data.find?.((p) => p.id === STAFF_POLL)?.myVote === "0");
check("une réponse par compte, à son nom", (await rest(SERVICE, `sondage_staff_votes?select=user_id&poll_id=eq.${STAFF_POLL}`)).data.length === 3);
check("choix invalide refusé (400)", (await staff("/api/staff/vote", { method: "POST", body: { pollId: STAFF_POLL, value: "9" } })).status === 400);
check("le staff ne peut pas répondre à un sondage normal par /staff (404)", (await staff("/api/staff/vote", { method: "POST", body: { pollId: REWARD_POLL, value: "0" } })).status === 404);
check("sondage inconnu (404)", (await staff("/api/staff/vote", { method: "POST", body: { pollId: "inconnu", value: "0" } })).status === 404);
await rest(SERVICE, `sondage_polls?id=eq.${STAFF_POLL}`, { method: "PATCH", body: { hub: false } });
check("réponse refusée une fois le sondage fermé (409)", (await staff("/api/staff/vote", { method: "POST", body: { pollId: STAFF_POLL, value: "1" } })).status === 409);
check("sondage fermé absent de la liste", !(await staff("/api/staff/polls")).data.some?.((p) => p.id === STAFF_POLL));
await cleanStaffData();

console.log("\n# Ajouter, promouvoir, rétrograder, retirer");
const added = await formAdmin("/api/team", { method: "POST", body: { app: "flexform", email: NEW_EMAIL, role: "staff" } });
check("nouveau compte créé avec mot de passe provisoire", added.status === 200 && added.data.created === true && typeof added.data.temporaryPassword === "string", JSON.stringify(added));
const newcomer = browser();
const r3 = await login(newcomer, NEW_EMAIL, added.data.temporaryPassword);
check("le nouveau staff se connecte, pour /staff seulement", r3.status === 200 && r3.data.staffPage === true && r3.data.apps?.length === 0, JSON.stringify(r3.data));
check("le nouveau staff ne peut pas voir l'équipe Flexform", (await newcomer("/api/team?app=flexform")).status === 403);
const newId = (await formAdmin("/api/team?app=flexform")).data.members?.find((m) => m.email === NEW_EMAIL)?.userId;
check("compte existant ajouté sans nouveau mot de passe", (await formAdmin("/api/team", { method: "POST", body: { app: "flexform", email: NEW_EMAIL, role: "staff" } })).data.created === false);
check("e-mail invalide refusé", (await formAdmin("/api/team", { method: "POST", body: { app: "flexform", email: "pas-un-email", role: "staff" } })).status === 400);
check("rôle invalide refusé", (await formAdmin("/api/team", { method: "POST", body: { app: "flexform", email: NEW_EMAIL, role: "super" } })).status === 400);
check("admin Flexform ne peut pas ajouter dans Flexfolio", (await formAdmin("/api/team", { method: "POST", body: { app: "flexfolio", email: NEW_EMAIL, role: "admin" } })).status === 403);
check("promouvoir admin", (await formAdmin("/api/team/role", { method: "POST", body: { app: "flexform", userId: newId, role: "admin" } })).status === 200 &&
  roleIn(await formAdmin("/api/team?app=flexform"), NEW_EMAIL) === "admin");
check("le nouvel admin entre dans Flexstaff", (await login(newcomer, NEW_EMAIL, added.data.temporaryPassword)).status === 200);

console.log("\n# Mots de passe");
// Vérifié directement auprès de Supabase Auth : les connexions à l'appli sont limitées à 10 par minute
const canSignIn = async (email, password) =>
  (await fetch(`${SB}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: env.SUPABASE_ANON_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) })).ok;
const changeOwn = (who, current, password) => who("/api/auth/password", { method: "POST", body: { current, password } });
const ownWrong = await changeOwn(newcomer, "faux", "Nouveau-mdp-1");
check("mot de passe actuel faux : refusé, la session reste ouverte", ownWrong.status === 400 && (await newcomer("/api/auth/me")).status === 200, JSON.stringify(ownWrong));
check("nouveau mot de passe trop court refusé", (await changeOwn(newcomer, added.data.temporaryPassword, "court")).status === 400);
const ownOk = await changeOwn(newcomer, added.data.temporaryPassword, "Nouveau-mdp-1");
check("un admin change son propre mot de passe, sa session continue", ownOk.status === 200 && (await newcomer("/api/auth/me")).status === 200, JSON.stringify(ownOk));
check("le nouveau mot de passe marche, l'ancien non", (await canSignIn(NEW_EMAIL, "Nouveau-mdp-1")) && !(await canSignIn(NEW_EMAIL, added.data.temporaryPassword)));
check("changer son mot de passe sans connexion : 401", (await changeOwn(browser(), "x", "Nouveau-mdp-1")).status === 401);

const reset = (who, userId, password) => who("/api/team/password", { method: "POST", body: { userId, password } });
const generated = await reset(formAdmin, newId);
check("admin Flexform change le mot de passe d'un membre : généré, renvoyé une fois", generated.status === 200 && generated.data.email === NEW_EMAIL && typeof generated.data.temporaryPassword === "string", JSON.stringify(generated));
check("le mot de passe généré marche, l'ancien non", (await canSignIn(NEW_EMAIL, generated.data.temporaryPassword)) && !(await canSignIn(NEW_EMAIL, "Nouveau-mdp-1")));
const typed = await reset(formAdmin, newId, "Choisi-par-admin-1");
check("mot de passe saisi par l'admin : non renvoyé, et il marche", typed.status === 200 && typed.data.temporaryPassword === undefined && (await canSignIn(NEW_EMAIL, "Choisi-par-admin-1")), JSON.stringify(typed));
check("mot de passe saisi trop court refusé", (await reset(formAdmin, newId, "court")).status === 400);
check("identifiant de membre invalide refusé", (await reset(formAdmin, "pas-un-id")).status === 400);
check("admin Flexform ne peut pas changer le mot de passe d'un super admin", (await reset(formAdmin, superId)).status === 409);
check("admin Flexfolio ne peut pas changer le mot de passe d'un membre de Flexform", (await reset(folioAdmin, newId)).status === 409);
check("son propre mot de passe refusé par cette route", (await reset(formAdmin, formAdminId)).status === 400);
check("changer un mot de passe sans connexion : 401", (await reset(browser(), newId)).status === 401);
check("rétrograder en staff", (await formAdmin("/api/team/role", { method: "POST", body: { app: "flexform", userId: newId, role: "staff" } })).status === 200);
check("la session du rétrogradé est coupée aussitôt", (await newcomer("/api/team?app=flexform")).status === 403);
check("impossible de modifier un super admin", (await formAdmin("/api/team/role", { method: "POST", body: { app: "flexform", userId: superId, role: "staff" } })).status === 409);
check("admin Flexfolio ne peut pas toucher l'équipe Flexform", (await folioAdmin("/api/team/role", { method: "POST", body: { app: "flexform", userId: newId, role: null } })).status === 403);

console.log("\n# Transmettre le rôle admin");
check("impossible de se transmettre à soi-même", (await formAdmin("/api/team/handover", { method: "POST", body: { app: "flexform", userId: formAdminId } })).status === 400);
const handover = await formAdmin("/api/team/handover", { method: "POST", body: { app: "flexform", userId: staffId } });
check("transmission : le staff devient admin", handover.status === 200, JSON.stringify(handover));
const afterHandover = await superAdmin("/api/team?app=flexform");
check("et l'ancien admin devient staff", roleIn(afterHandover, env.TEST_STAFF_EMAIL) === "admin" && roleIn(afterHandover, env.TEST_ADMIN_EMAIL) === "staff", JSON.stringify(afterHandover.data));
check("l'ancien admin n'a plus accès à Flexstaff", (await formAdmin("/api/team?app=flexform")).status === 403);
// Retour à l'état de départ
await superAdmin("/api/team/role", { method: "POST", body: { app: "flexform", userId: formAdminId, role: "admin" } });
await superAdmin("/api/team/role", { method: "POST", body: { app: "flexform", userId: staffId, role: "staff" } });
check("retirer l'accès", (await superAdmin("/api/team/role", { method: "POST", body: { app: "flexform", userId: newId, role: null } })).status === 200 &&
  roleIn(await superAdmin("/api/team?app=flexform"), NEW_EMAIL) === undefined);
console.log("\n# Calendrier (Flexstaff)");
// Rôles Flexstaff le temps de cette partie (retirés à la fin) : staff Flexform = staff Flexstaff, admin Flexform = admin Flexstaff.
// L'admin Flexfolio reste sans rôle Flexstaff.
const serviceRest = (path, init = {}) => admin(`/rest/v1/${path}`, init);
const flexstaffRoles = `app_roles?app=eq.flexstaff&user_id=in.(${staffId},${formAdminId})`;
await serviceRest("staff_projects?title=like.e2e-*", { method: "DELETE" });
await serviceRest("app_roles?on_conflict=user_id,app", {
  method: "POST",
  headers: { Prefer: "resolution=merge-duplicates" },
  body: JSON.stringify([{ user_id: staffId, app: "flexstaff", role: "staff" }, { user_id: formAdminId, app: "flexstaff", role: "admin" }]),
});
// Les connexions sont limitées à 10 par minute et ce test en a déjà fait beaucoup
await serviceRest("suite_rate_limits?key=like.flexstaff:login:*", { method: "DELETE" });
try {
  const { users } = await (await admin("/auth/v1/admin/users?per_page=200")).json();
  const folioId = users.find((u) => u.email === env.TEST_FOLIO_EMAIL)?.id;
  const projects = (who, method, body) => who("/api/projects", { method, body });
  const tasks = (who, method, body) => who("/api/tasks", { method, body });
  const assignees = (who, method, body) => who("/api/tasks/assignees", { method, body });
  const fields = (extra = {}) => ({
    title: "e2e-evenement", shortDescription: "Soirée", longDescription: "Soirée de rentrée du BDE.",
    eventDate: "2026-12-10", communicationStart: "2026-11-01", ticketingOpen: "2026-11-15", ticketingClose: "2026-12-09", ...extra,
  });

  check("sans connexion : calendrier refusé (401)", (await browser()("/api/projects")).status === 401);
  check("compte sans rôle Flexstaff (admin Flexfolio) : calendrier refusé (403)", (await folioAdmin("/api/projects")).status === 403);
  const s1 = await login(staff, env.TEST_STAFF_EMAIL, env.TEST_STAFF_PASSWORD);
  check("un staff Flexstaff (admin d'aucune appli) se connecte", s1.status === 200 && s1.data.flexstaff === "staff" && s1.data.apps?.length === 0, JSON.stringify(s1.data));
  check("le staff Flexstaff ne peut pas lire une équipe (/api/team)", (await staff("/api/team?app=flexform")).status === 403);
  check("le staff Flexstaff ne peut pas ajouter de membre", (await staff("/api/team", { method: "POST", body: { app: "flexstaff", email: NEW_EMAIL, role: "staff" } })).status === 403);
  const adminMe = (await formAdmin("/api/auth/me")).data;
  check("l'admin Flexstaff gère l'équipe Flexstaff", adminMe.flexstaff === "admin" && adminMe.apps?.some((a) => a.app === "flexstaff"), JSON.stringify(adminMe));
  check("l'équipe Flexstaff liste le staff", roleIn(await formAdmin("/api/team?app=flexstaff"), env.TEST_STAFF_EMAIL) === "staff");

  for (const [extra, label] of [
    [{ ticketingOpen: "2026-12-09", ticketingClose: "2026-11-15" }, "billetterie qui ouvre après sa fermeture"],
    [{ communicationStart: "2026-12-11" }, "communication qui commence après l'événement"],
    [{ shortDescription: " " }, "description courte vide"],
    [{ eventDate: "2026-02-30" }, "date qui n'existe pas"],
    [{ ticketingClose: undefined }, "date manquante"],
  ]) {
    const r = await projects(formAdmin, "POST", fields(extra));
    check(`projet refusé : ${label} (400)`, r.status === 400, JSON.stringify(r));
  }
  const p = await projects(formAdmin, "POST", fields());
  check("l'admin Flexstaff crée un projet", p.status === 200 && typeof p.data.id === "string", JSON.stringify(p));
  const projectId = p.data.id;
  check("le staff Flexstaff ne peut pas créer de projet (403)", (await projects(staff, "POST", fields({ title: "e2e-pirate" }))).status === 403);
  check("le staff Flexstaff ne peut pas modifier un projet (403)", (await projects(staff, "PATCH", fields({ id: projectId, title: "e2e-pirate" }))).status === 403);
  check("le staff Flexstaff ne peut pas supprimer un projet (403)", (await projects(staff, "DELETE", { id: projectId })).status === 403);
  const plan = await staff("/api/projects");
  check("le staff Flexstaff voit le projet dans le calendrier", plan.status === 200 && plan.data.role === "staff" && plan.data.projects?.some((x) => x.id === projectId && x.eventDate === "2026-12-10"), JSON.stringify(plan.status));
  check("projet inconnu : 404", (await staff("/api/projects?id=00000000-0000-0000-0000-000000000000")).status === 404);
  check("identifiant de projet invalide : 400", (await staff("/api/projects?id=pas-un-id")).status === 400);

  const t = await tasks(staff, "POST", { projectId, title: "e2e-affiches", description: "Imprimer 50 affiches", dueDate: "2026-11-20" });
  check("le staff Flexstaff ajoute une tâche", t.status === 200 && typeof t.data.id === "string", JSON.stringify(t));
  const taskId = t.data.id;
  check("compte sans rôle Flexstaff ne peut pas ajouter de tâche (403)", (await tasks(folioAdmin, "POST", { projectId, title: "e2e-pirate" })).status === 403);
  check("tâche refusée sans titre (400)", (await tasks(staff, "POST", { projectId, title: "" })).status === 400);
  check("le staff Flexstaff ne peut pas renommer une tâche (403)", (await tasks(staff, "PATCH", { id: taskId, title: "e2e-pirate" })).status === 403);
  check("le staff Flexstaff ne peut pas cocher une tâche où il n'est pas inscrit (403)", (await tasks(staff, "PATCH", { id: taskId, done: true })).status === 403);
  check("le staff Flexstaff s'inscrit sur la tâche", (await assignees(staff, "POST", { taskId })).status === 200);
  check("s'inscrire deux fois ne change rien", (await assignees(staff, "POST", { taskId })).status === 200);
  check("le staff Flexstaff inscrit coche la tâche", (await tasks(staff, "PATCH", { id: taskId, done: true })).status === 200);
  check("le staff Flexstaff ne peut pas inscrire quelqu'un d'autre (403)", (await assignees(staff, "POST", { taskId, userId: formAdminId })).status === 403);
  check("le staff Flexstaff ne peut pas supprimer une tâche (403)", (await tasks(staff, "DELETE", { id: taskId })).status === 403);
  check("l'admin Flexstaff ne peut pas inscrire un compte hors de l'équipe (400)", (await assignees(formAdmin, "POST", { taskId, userId: folioId })).status === 400);
  check("l'admin Flexstaff inscrit un membre", (await assignees(formAdmin, "POST", { taskId, userId: formAdminId })).status === 200);
  check("le staff Flexstaff ne peut pas retirer quelqu'un d'autre (403)", (await assignees(staff, "DELETE", { taskId, userId: formAdminId })).status === 403);
  const detail = await staff(`/api/projects?id=${projectId}`);
  const task = detail.data.tasks?.find((x) => x.id === taskId);
  check("la page du projet : tâche faite, deux inscrits, e-mails de l'équipe",
    detail.status === 200 && task?.done === true && task.assignees.length === 2 && task.assignees.includes(detail.data.me)
      && detail.data.members?.some((m) => m.userId === formAdminId && m.email === env.TEST_ADMIN_EMAIL) && detail.data.project.tasksDone === 1, JSON.stringify(detail.data));
  check("le staff Flexstaff se retire de la tâche", (await assignees(staff, "DELETE", { taskId })).status === 200);
  check("le staff Flexstaff ne peut plus décocher la tâche qu'il a quittée (403)", (await tasks(staff, "PATCH", { id: taskId, done: false })).status === 403);
  check("l'admin Flexstaff modifie la tâche", (await tasks(formAdmin, "PATCH", { id: taskId, title: "e2e-affiches-a3", dueDate: null, done: false })).status === 200);
  check("l'admin Flexstaff retire quelqu'un d'une tâche", (await assignees(formAdmin, "DELETE", { taskId, userId: formAdminId })).status === 200);
  check("l'admin Flexstaff modifie le projet", (await projects(formAdmin, "PATCH", fields({ id: projectId, title: "e2e-evenement-2" }))).status === 200
    && (await staff(`/api/projects?id=${projectId}`)).data.project?.title === "e2e-evenement-2");
  check("l'admin Flexstaff supprime une tâche", (await tasks(formAdmin, "DELETE", { id: taskId })).status === 200);
  check("l'admin Flexstaff supprime le projet", (await projects(formAdmin, "DELETE", { id: projectId })).status === 200 && (await staff(`/api/projects?id=${projectId}`)).status === 404);

  await serviceRest(`app_roles?app=eq.flexstaff&user_id=eq.${staffId}`, { method: "DELETE" });
  // Le compte garde son rôle staff dans Flexform : il reste connecté, pour /staff seulement
  const afterRemoval = await staff("/api/auth/me");
  check("rôle Flexstaff retiré : le calendrier est coupé aussitôt, /staff reste ouvert", (await staff("/api/projects")).status === 403
    && afterRemoval.status === 200 && afterRemoval.data.flexstaff === null && afterRemoval.data.staffPage === true, JSON.stringify(afterRemoval.data));
} finally {
  await serviceRest("staff_projects?title=like.e2e-*", { method: "DELETE" });
  await serviceRest(flexstaffRoles, { method: "DELETE" });
}

check("déconnexion", (await superAdmin("/api/auth/logout", { method: "POST" })).status === 200 && (await superAdmin("/api/team?app=flexform")).status === 401);

await deleteUser(NEW_EMAIL);
console.log(`\n${failures ? `${failures} échec(s)` : "Tout est passé."}`);
process.exitCode = failures ? 1 : 0;

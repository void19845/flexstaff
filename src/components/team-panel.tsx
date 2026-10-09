"use client";

import Link from "next/link";
import { useEffect, useEffectEvent, useState } from "react";
import { AddMemberForm } from "@/components/add-member-form";
import { OwnPasswordForm } from "@/components/own-password-form";
import { PasswordNotice, type CreatedAccount } from "@/components/password-notice";
import { ResetPasswordForm } from "@/components/reset-password-form";
import { TeamCard } from "@/components/team-card";
import { signOut as endSession } from "@/lib/client/account";
import { ApiError, api, isAuthError } from "@/lib/client/api";
import type { Me, Member, Team } from "@/lib/shared/types";

/**
 * Lance une action sur l'équipe ; renvoie true si elle a réussi. L'équipe est rechargée ensuite (succès ou erreur).
 * selfChanged : l'action touche aux droits du compte connecté, qui sont relus (/api/auth/me).
 */
export type Run = (action: () => Promise<unknown>, options?: { selfChanged?: boolean }) => Promise<boolean>;

const RIGHTS_REMOVED = "Tu n'es plus admin d'aucune appli de la suite : l'accès à Flexstaff est fermé.";

/**
 * Tableau de bord : un onglet par appli administrée, son équipe et le formulaire d'ajout.
 * onNoApps : le compte n'administre plus aucune appli mais garde un rôle dans Flexform (accès à /staff).
 */
export function TeamPanel({
  account,
  onSignedOut,
  onNoApps,
}: {
  account: Me;
  onSignedOut: (message: string) => void;
  onNoApps: (me: Me) => void;
}) {
  const [me, setMe] = useState(account);
  const [app, setApp] = useState(account.apps[0]?.app ?? "");
  /** Dernière équipe reçue ; elle peut être celle d'un autre onglet le temps du chargement */
  const [team, setTeam] = useState<Team | null>(null);
  const [loadError, setLoadError] = useState<{ app: string; message: string } | null>(null);
  /** Change après chaque action : relance le chargement de l'équipe */
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  /** Déconnexion en cours : plus aucun appel au serveur */
  const [stopped, setStopped] = useState(false);
  const [created, setCreated] = useState<CreatedAccount | null>(null);
  /** Membre dont l'admin change le mot de passe, dans l'onglet de cette appli */
  const [resetFor, setResetFor] = useState<{ app: string; member: Member } | null>(null);
  const [ownPassword, setOwnPassword] = useState(false);
  /** Objet neuf à chaque message : le même message affiché deux fois relance les 3,5 s */
  const [toast, setToast] = useState<{ text: string } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const flash = (text: string): void => setToast({ text });

  const signOut = (message = ""): void => {
    setStopped(true);
    void endSession().then(() => onSignedOut(message));
  };

  const onLoadError = useEffectEvent((loadedApp: string, err: unknown) => {
    if (isAuthError(err)) signOut(err.message);
    else setLoadError({ app: loadedApp, message: (err as Error).message });
  });

  useEffect(() => {
    if (stopped || !app) return;
    let ignore = false;
    api<Team>(`/api/team?app=${encodeURIComponent(app)}`)
      .then((t) => {
        if (ignore) return;
        setTeam(t);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (!ignore) onLoadError(app, err);
      });
    return () => {
      ignore = true;
    };
  }, [app, version, stopped]);

  /** Relit les droits du compte : change d'onglet si l'appli n'est plus administrée, retour à la connexion s'il n'en reste aucune. */
  async function refreshMe(): Promise<void> {
    let fresh: Me;
    try {
      fresh = await api<Me>("/api/auth/me");
    } catch (err) {
      // 403 : plus admin d'aucune appli ; 401 (session) remonte jusqu'à run
      if (err instanceof ApiError && err.status === 403) return signOut(RIGHTS_REMOVED);
      throw err;
    }
    if (!fresh.apps.length) return fresh.staffPage ? onNoApps(fresh) : signOut(RIGHTS_REMOVED);
    setMe(fresh);
    if (!fresh.apps.some((a) => a.app === app)) {
      const lost = me.apps.find((a) => a.app === app)?.name ?? app;
      flash(`Tu n'es plus admin de ${lost}.`);
      setApp(fresh.apps[0].app);
    }
  }

  const run: Run = async (action, { selfChanged = false } = {}) => {
    setBusy(true);
    let ok = false;
    try {
      await action();
      ok = true;
      if (selfChanged) await refreshMe();
    } catch (err) {
      if (isAuthError(err)) {
        signOut(err.message);
        return false;
      }
      flash((err as Error).message);
    } finally {
      setBusy(false);
    }
    setVersion((v) => v + 1);
    return ok;
  };

  const current = me.apps.find((a) => a.app === app);
  const shown = team?.app === app ? team : null;
  const error = loadError?.app === app ? loadError.message : "";

  return (
    <>
      <header className="topbar">
        <div>
          <p className="eyebrow">Flex Suite</p>
          <h1>Équipe</h1>
        </div>
        <div className="topbar-actions">
          <span className="muted small">{me.email}</span>
          {me.superAdmin && <span className="badge role-super">Super admin</span>}
          {me.staffPage && (
            <Link className="btn ghost small" href="/staff">
              Récompenses
            </Link>
          )}
          <button type="button" className="btn ghost small" onClick={() => setOwnPassword(true)}>
            Mon mot de passe
          </button>
          <button type="button" className="btn ghost small" onClick={() => signOut()}>
            Déconnexion
          </button>
        </div>
      </header>
      <nav className="tabs" role="tablist" aria-label="Applis de la suite">
        {me.apps.map((a) => (
          <button key={a.app} type="button" className="btn tab" role="tab" aria-selected={a.app === app} onClick={() => setApp(a.app)}>
            {a.name}
          </button>
        ))}
      </nav>
      {created && <PasswordNotice key={created.password} account={created} onClose={() => setCreated(null)} />}
      <div className="layout">
        <main>
          {shown ? (
            <TeamCard team={shown} me={me} busy={busy} run={run} onResetPassword={(member) => setResetFor({ app, member })} />
          ) : (
            <div className="card">
              {error ? (
                <p className="error" role="alert">
                  {error}
                </p>
              ) : (
                <p className="muted">Chargement de l&apos;équipe…</p>
              )}
            </div>
          )}
        </main>
        <aside>
          {ownPassword && <OwnPasswordForm busy={busy} run={run} onClose={() => setOwnPassword(false)} flash={flash} />}
          {current && resetFor?.app === current.app && (
            <ResetPasswordForm
              key={resetFor.member.userId}
              app={current}
              member={resetFor.member}
              busy={busy}
              run={run}
              onGenerated={setCreated}
              onClose={() => setResetFor(null)}
              flash={flash}
            />
          )}
          {current && (
            <AddMemberForm
              key={current.app}
              app={current}
              me={me}
              members={shown?.members ?? []}
              busy={busy}
              run={run}
              onCreated={setCreated}
              flash={flash}
            />
          )}
        </aside>
      </div>
      <p className="toast" role="status" hidden={!toast}>
        {toast?.text}
      </p>
    </>
  );
}

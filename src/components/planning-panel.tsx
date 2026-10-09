"use client";

import { useEffect, useEffectEvent, useState, type ReactNode } from "react";
import { OwnPasswordForm } from "@/components/own-password-form";
import { PlanningCalendar } from "@/components/planning-calendar";
import { ProjectForm } from "@/components/project-form";
import { ProjectView } from "@/components/project-view";
import type { Run } from "@/components/team-panel";
import { signOut as endSession } from "@/lib/client/account";
import { ApiError, api, isAuthError } from "@/lib/client/api";
import { formatShortDay } from "@/lib/client/format";
import type { Planning, Project } from "@/lib/shared/planning";
import type { Me } from "@/lib/shared/types";

/** Aujourd'hui en AAAA-MM-JJ (heure locale). Lu seulement dans les effets et les gestionnaires, jamais au rendu. */
function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const NOT_IN_TEAM = "Tu n'es plus dans l'équipe Flexstaff : l'accès au calendrier est fermé.";

/**
 * Calendrier de l'équipe Flexstaff : mois affiché, page d'un projet et ses tâches, formulaire de projet (admins).
 * Le rôle affiché vient de la dernière réponse du serveur, qui le relit dans la base à chaque requête.
 */
export function PlanningPanel({
  account,
  nav,
  onAccountChange,
  onSignedOut,
}: {
  account: Me;
  nav: ReactNode;
  onAccountChange: (me: Me) => void;
  onSignedOut: (message: string) => void;
}) {
  const [planning, setPlanning] = useState<Planning | null>(null);
  const [loadError, setLoadError] = useState("");
  /** Change après chaque action : relance le chargement du calendrier et du projet ouvert */
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  /** Déconnexion en cours : plus aucun appel au serveur */
  const [stopped, setStopped] = useState(false);
  const [today, setToday] = useState<string | null>(null);
  const [shownMonth, setShownMonth] = useState<{ year: number; month: number } | null>(null);
  /** Projet ouvert */
  const [selected, setSelected] = useState<string | null>(null);
  /** Formulaire de projet ouvert : project null pour un nouveau projet */
  const [form, setForm] = useState<{ project: Project | null } | null>(null);
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

  /**
   * Erreur d'une requête. 401 : retour à la connexion. 403 : les droits sont relus ; un compte qui n'est plus dans
   * l'équipe Flexstaff passe à ses autres sections (ou à la connexion), les autres voient simplement le message.
   */
  async function handleError(err: unknown): Promise<void> {
    if (!(err instanceof ApiError) || (err.status !== 401 && err.status !== 403)) {
      flash((err as Error).message);
      return;
    }
    if (err.status === 401) return signOut(err.message);
    let fresh: Me;
    try {
      fresh = await api<Me>("/api/auth/me");
    } catch (meErr) {
      if (isAuthError(meErr)) return signOut(meErr.message);
      flash((meErr as Error).message);
      return;
    }
    if (!fresh.flexstaff) {
      if (!fresh.apps.length) return signOut(NOT_IN_TEAM);
      return onAccountChange(fresh);
    }
    flash(err.message);
  }

  const onLoadError = useEffectEvent((err: unknown) => {
    setLoadError((err as Error).message);
    void handleError(err);
  });

  useEffect(() => {
    if (stopped) return;
    let ignore = false;
    api<Planning>("/api/projects")
      .then((p) => {
        if (ignore) return;
        const now = todayIso();
        setPlanning(p);
        setLoadError("");
        setToday(now);
        setShownMonth((m) => m ?? { year: Number(now.slice(0, 4)), month: Number(now.slice(5, 7)) - 1 });
      })
      .catch((err: unknown) => {
        if (!ignore) onLoadError(err);
      });
    return () => {
      ignore = true;
    };
  }, [version, stopped]);

  const run: Run = async (action) => {
    setBusy(true);
    let ok = false;
    try {
      await action();
      ok = true;
    } catch (err) {
      await handleError(err);
    } finally {
      setBusy(false);
    }
    setVersion((v) => v + 1);
    return ok;
  };

  const role = planning?.role ?? account.flexstaff;
  const isAdmin = role === "admin";
  const upcoming = today && planning ? planning.projects.filter((p) => p.eventDate >= today) : [];

  return (
    <>
      <header className="topbar">
        <div>
          <p className="eyebrow">Flex Suite</p>
          <h1>Calendrier</h1>
        </div>
        <div className="topbar-actions">
          <span className="muted small">{account.email}</span>
          {account.superAdmin ? (
            <span className="badge role-super">Super admin</span>
          ) : (
            <span className={`badge role-${role}`}>{isAdmin ? "Admin Flexstaff" : "Staff Flexstaff"}</span>
          )}
          <button type="button" className="btn ghost small" onClick={() => setOwnPassword(true)}>
            Mon mot de passe
          </button>
          <button type="button" className="btn ghost small" onClick={() => signOut()}>
            Déconnexion
          </button>
        </div>
      </header>
      {nav}
      <div className="layout">
        <main>
          {selected ? (
            <ProjectView
              key={selected}
              id={selected}
              version={version}
              busy={busy}
              run={run}
              onBack={() => setSelected(null)}
              onEdit={(project) => setForm({ project })}
              onLoadFailed={(err) => {
                if (isAuthError(err)) void handleError(err);
              }}
            />
          ) : planning && shownMonth ? (
            <PlanningCalendar
              projects={planning.projects}
              year={shownMonth.year}
              month={shownMonth.month}
              today={today}
              onMonth={(year, month) => setShownMonth({ year, month })}
              onOpen={setSelected}
            />
          ) : (
            <div className="card">
              {loadError ? (
                <p className="error" role="alert">
                  {loadError}
                </p>
              ) : (
                <p className="muted">Chargement du calendrier…</p>
              )}
            </div>
          )}
        </main>
        <aside>
          {ownPassword && <OwnPasswordForm busy={busy} run={run} onClose={() => setOwnPassword(false)} flash={flash} />}
          {isAdmin && form && (
            <ProjectForm
              key={form.project?.id ?? "new"}
              project={form.project}
              busy={busy}
              run={run}
              onSaved={(id) => {
                setForm(null);
                setSelected(id);
                flash(form.project ? "Projet enregistré." : "Projet créé.");
              }}
              onClose={() => setForm(null)}
            />
          )}
          {isAdmin && !form && (
            <button type="button" className="btn primary" onClick={() => setForm({ project: null })}>
              Nouveau projet
            </button>
          )}
          <section className="card">
            <h2>À venir</h2>
            {upcoming.length ? (
              <ul className="upcoming">
                {upcoming.map((p) => (
                  <li key={p.id}>
                    <button type="button" className="btn link" onClick={() => setSelected(p.id)}>
                      {p.title}
                    </button>
                    <span className="muted small">{`${formatShortDay(p.eventDate)} · ${p.tasksDone}/${p.tasks} tâches faites`}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">Aucun événement à venir.</p>
            )}
          </section>
        </aside>
      </div>
      <p className="toast" role="status" hidden={!toast}>
        {toast?.text}
      </p>
    </>
  );
}

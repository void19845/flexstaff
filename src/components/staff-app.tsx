"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { LoginForm } from "@/components/login-form";
import { PlanningPanel } from "@/components/planning-panel";
import { TeamPanel } from "@/components/team-panel";
import { currentAccount, signOut } from "@/lib/client/account";
import type { Me } from "@/lib/shared/types";

/** planning : calendrier de l'équipe Flexstaff ; team : équipes des applis administrées */
type Section = "planning" | "team";

/**
 * loading : en attente de /api/auth/me ; login : connexion, avec un message éventuel ; panel : tableau de bord.
 * id change à chaque retour à la connexion : le formulaire est recréé (message affiché, bouton réactivé).
 */
type View = { name: "loading" } | { name: "login"; message: string; id: number } | { name: "panel"; me: Me; section: Section };

function toLogin(message: string): (view: View) => View {
  return (view) => ({ name: "login", message, id: view.name === "login" ? view.id + 1 : 0 });
}

/** Section ouverte : celle demandée si le compte y a encore droit, sinon l'autre. */
function toPanel(me: Me, wanted?: Section): View {
  const allowed: Section[] = [...(me.flexstaff ? ["planning" as const] : []), ...(me.apps.length ? ["team" as const] : [])];
  return { name: "panel", me, section: wanted && allowed.includes(wanted) ? wanted : allowed[0] ?? "team" };
}

const SECTION_LABEL: Record<Section, string> = { planning: "Calendrier", team: "Équipe" };

/**
 * Flexstaff : connexion d'un admin de la suite ou d'un membre de l'équipe Flexstaff, puis calendrier et équipes.
 * Un compte qui a seulement un rôle dans Flexform n'a accès qu'à la remise des récompenses (/staff).
 */
export function StaffApp() {
  const [view, setView] = useState<View>({ name: "loading" });

  useEffect(() => {
    let ignore = false;
    currentAccount()
      .then((me) => {
        if (!ignore) setView(me ? toPanel(me) : toLogin(""));
      })
      .catch((err: unknown) => {
        if (!ignore) setView(toLogin((err as Error).message));
      });
    return () => {
      ignore = true;
    };
  }, []);

  if (view.name === "loading") return null;
  if (view.name === "panel" && !view.me.apps.length && !view.me.flexstaff) {
    return <StaffOnly me={view.me} onSignedOut={() => setView(toLogin(""))} />;
  }
  if (view.name === "panel") {
    const { me, section } = view;
    const onSignedOut = (message: string): void => setView(toLogin(message));
    const onAccountChange = (fresh: Me): void => setView((v) => toPanel(fresh, v.name === "panel" ? v.section : undefined));
    // Navigation seulement pour un compte qui a accès aux deux sections
    const nav =
      me.flexstaff && me.apps.length ? (
        <nav className="tabs" aria-label="Sections de Flexstaff">
          {(["planning", "team"] as const).map((s) => (
            <button key={s} type="button" className="btn tab" aria-current={s === section ? "page" : undefined} onClick={() => setView(toPanel(me, s))}>
              {SECTION_LABEL[s]}
            </button>
          ))}
        </nav>
      ) : null;
    return section === "planning" ? (
      <PlanningPanel account={me} nav={nav} onAccountChange={onAccountChange} onSignedOut={onSignedOut} />
    ) : (
      <TeamPanel account={me} nav={nav} onAccountChange={onAccountChange} onSignedOut={onSignedOut} />
    );
  }
  return (
    <div className="narrow">
      <LoginForm key={view.id} message={view.message} onSignedIn={(me) => setView(toPanel(me))} />
    </div>
  );
}

/** Compte sans appli à administrer, avec un rôle dans Flexform : lien vers la remise des récompenses. */
function StaffOnly({ me, onSignedOut }: { me: Me; onSignedOut: () => void }) {
  return (
    <div className="narrow">
      <div className="card login">
        <p className="eyebrow">Flex Suite</p>
        <h1>Staff Flexform</h1>
        <p className="muted">{`Le compte ${me.email} a accès à la remise des récompenses de Flexform. La gestion des équipes est réservée aux admins.`}</p>
        <div className="actions">
          <Link className="btn primary" href="/staff">
            Remise des récompenses
          </Link>
          <button type="button" className="btn ghost" onClick={() => void signOut().then(onSignedOut)}>
            Déconnexion
          </button>
        </div>
      </div>
    </div>
  );
}

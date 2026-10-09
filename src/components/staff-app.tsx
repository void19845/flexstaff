"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { LoginForm } from "@/components/login-form";
import { TeamPanel } from "@/components/team-panel";
import { currentAccount, signOut } from "@/lib/client/account";
import type { Me } from "@/lib/shared/types";

/**
 * loading : en attente de /api/auth/me ; login : connexion, avec un message éventuel ; panel : tableau de bord.
 * id change à chaque retour à la connexion : le formulaire est recréé (message affiché, bouton réactivé).
 */
type View = { name: "loading" } | { name: "login"; message: string; id: number } | { name: "panel"; me: Me };

function toLogin(message: string): (view: View) => View {
  return (view) => ({ name: "login", message, id: view.name === "login" ? view.id + 1 : 0 });
}

/**
 * Flexstaff : connexion d'un admin de la suite, puis gestion des équipes de ses applis.
 * Un compte qui a seulement un rôle dans Flexform n'a accès qu'à la remise des récompenses (/staff).
 */
export function StaffApp() {
  const [view, setView] = useState<View>({ name: "loading" });

  useEffect(() => {
    let ignore = false;
    currentAccount()
      .then((me) => {
        if (!ignore) setView(me ? { name: "panel", me } : toLogin(""));
      })
      .catch((err: unknown) => {
        if (!ignore) setView(toLogin((err as Error).message));
      });
    return () => {
      ignore = true;
    };
  }, []);

  if (view.name === "loading") return null;
  if (view.name === "panel" && !view.me.apps.length) return <StaffOnly me={view.me} onSignedOut={() => setView(toLogin(""))} />;
  if (view.name === "panel") {
    return (
      <TeamPanel
        account={view.me}
        onSignedOut={(message) => setView(toLogin(message))}
        onNoApps={(me) => setView({ name: "panel", me })}
      />
    );
  }
  return (
    <div className="narrow">
      <LoginForm key={view.id} message={view.message} onSignedIn={(me) => setView({ name: "panel", me })} />
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

"use client";

import { useRef, useState, type FormEvent } from "react";
import { post } from "@/lib/client/api";
import { MAX_EMAIL_LENGTH, type Me } from "@/lib/shared/types";

/**
 * Connexion par e-mail et mot de passe (compte Supabase). Réservée aux admins d'une appli de la suite et au staff
 * de Flexform. title, intro, note : textes de la page (par défaut, ceux de la gestion des équipes).
 */
export function LoginForm({
  title = "Équipe",
  intro = "Ajoute des membres et transmets le rôle admin des applis de la suite.",
  note = "Réservé aux admins d'une appli de la suite et au staff de Flexform.",
  message = "",
  onSignedIn,
}: {
  title?: string;
  intro?: string;
  note?: string;
  message?: string;
  onSignedIn: (me: Me) => void;
}) {
  const [error, setError] = useState(message);
  const [pending, setPending] = useState(false);
  const password = useRef<HTMLInputElement>(null);

  async function submit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    setPending(true);
    setError("");
    try {
      onSignedIn(await post<Me>("/api/auth/login", { email: data.get("email"), password: data.get("password") }));
    } catch (err) {
      setError((err as Error).message);
      setPending(false);
      password.current?.select();
    }
  }

  return (
    <form className="card login" onSubmit={submit}>
      <p className="eyebrow">Flex Suite</p>
      <h1>{title}</h1>
      <p className="muted">{intro}</p>
      <label className="field">
        <span>E-mail</span>
        <input
          name="email"
          type="email"
          placeholder="prenom.nom@exemple.fr"
          autoComplete="username"
          maxLength={MAX_EMAIL_LENGTH}
          required
          autoFocus
        />
      </label>
      <label className="field">
        <span>Mot de passe</span>
        <input ref={password} name="password" type="password" placeholder="Mot de passe" autoComplete="current-password" required />
      </label>
      <p className="error" role="alert">
        {error}
      </p>
      <button type="submit" className="btn primary big" disabled={pending}>
        Se connecter
      </button>
      <p className="muted small">{note}</p>
    </form>
  );
}

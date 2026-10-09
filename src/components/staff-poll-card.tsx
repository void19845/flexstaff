"use client";

import { useState, type ReactNode } from "react";
import { post } from "@/lib/client/api";
import { MAX_ANSWER_LENGTH, type StaffPoll } from "@/lib/shared/types";

/**
 * Carte d'un sondage réservé au staff de Flexform, répondu avec le compte connecté. À afficher avec key={poll.id} :
 * la carte est gardée d'un rafraîchissement à l'autre pour ne pas effacer une réponse en cours de saisie.
 * startedAt : heure de départ de la requête qui a lu ce sondage. Seuls les sondages ouverts sont affichés.
 */
export function StaffPollCard({ poll, startedAt, onVoted }: { poll: StaffPoll; startedAt: number; onVoted: () => void }) {
  /** Dernier vote envoyé et son heure : un état lu avant cette heure garde le vote local. */
  const [sent, setSent] = useState<{ value: string; at: number } | null>(null);
  const myVote = sent && startedAt < sent.at ? sent.value : poll.myVote;
  const [error, setError] = useState("");
  const [text, setText] = useState(myVote ?? "");

  /** at : heure du clic, prise dans le gestionnaire d'événement (pas pendant le rendu) */
  async function send(value: string, at: number): Promise<void> {
    if (!value) {
      setError("Écris une réponse avant d'envoyer.");
      return;
    }
    setError("");
    const previous = sent;
    setSent({ value, at });
    try {
      await post("/api/staff/vote", { pollId: poll.id, value });
      onVoted();
    } catch (err) {
      // Vote refusé : on revient au vote affiché avant l'envoi
      setSent(previous);
      setError((err as Error).message);
    }
  }

  let body: ReactNode;
  if (poll.kind === "choice") {
    body = (
      <div className="choices">
        {poll.options.map((o, i) => (
          <button
            key={o.id}
            type="button"
            className={`btn choice c${i % 4}${myVote === o.id ? " selected" : ""}`}
            onClick={() => void send(o.id, Date.now())}
          >
            {o.label}
          </button>
        ))}
      </div>
    );
  } else {
    body = (
      <>
        <textarea
          rows={3}
          maxLength={MAX_ANSWER_LENGTH}
          placeholder="Ta réponse…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="button" className="btn primary" onClick={() => void send(text.trim(), Date.now())}>
          Envoyer
        </button>
      </>
    );
  }

  let hint: string;
  if (error) hint = error;
  else if (poll.kind === "text") hint = myVote ? "Réponse envoyée. Tu peux la modifier quand tu veux." : "Écris ta réponse puis envoie-la.";
  else hint = myVote ? "Vote enregistré. Tu peux changer d'avis quand tu veux." : "Choisis une réponse.";

  return (
    <article className="card poll-card hub-card">
      <p className="eyebrow">Réservé au staff</p>
      <h3 className="question">{poll.question}</h3>
      <div className="vote-body">{body}</div>
      <p className={error ? "hint error" : "hint"}>{hint}</p>
    </article>
  );
}

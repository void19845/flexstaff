"use client";

import { useState, type FormEvent } from "react";
import type { Run } from "@/components/team-panel";
import { post } from "@/lib/client/api";
import { MAX_LONG_DESCRIPTION, MAX_PROJECT_TITLE, MAX_SHORT_DESCRIPTION, type Project, type ProjectFields } from "@/lib/shared/planning";

const EMPTY: ProjectFields = {
  title: "",
  shortDescription: "",
  longDescription: "",
  eventDate: "",
  communicationStart: "",
  ticketingOpen: "",
  ticketingClose: "",
};

const DATES: { key: keyof ProjectFields; label: string }[] = [
  { key: "eventDate", label: "Date de l'événement" },
  { key: "communicationStart", label: "Début de la communication" },
  { key: "ticketingOpen", label: "Ouverture de la billetterie" },
  { key: "ticketingClose", label: "Fermeture de la billetterie" },
];

/** Création (project null) ou modification d'un projet, réservées aux admins de Flexstaff. Tous les champs sont obligatoires. */
export function ProjectForm({
  project,
  busy,
  run,
  onSaved,
  onClose,
}: {
  project: Project | null;
  busy: boolean;
  run: Run;
  onSaved: (id: string) => void;
  onClose: () => void;
}) {
  const [fields, setFields] = useState<ProjectFields>(() => (project ? { ...project } : EMPTY));
  const set = (key: keyof ProjectFields, value: string): void => setFields((f) => ({ ...f, [key]: value }));

  function submit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    const body: ProjectFields = {
      title: fields.title,
      shortDescription: fields.shortDescription,
      longDescription: fields.longDescription,
      eventDate: fields.eventDate,
      communicationStart: fields.communicationStart,
      ticketingOpen: fields.ticketingOpen,
      ticketingClose: fields.ticketingClose,
    };
    void run(async () => {
      if (project) {
        await post("/api/projects", { id: project.id, ...body }, "PATCH");
        onSaved(project.id);
      } else {
        onSaved((await post<{ id: string }>("/api/projects", body)).id);
      }
    });
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>{project ? "Modifier le projet" : "Nouveau projet"}</h2>
      <label className="field">
        <span>Titre</span>
        <input required maxLength={MAX_PROJECT_TITLE} value={fields.title} onChange={(e) => set("title", e.target.value)} />
      </label>
      <label className="field">
        <span>Description courte</span>
        <input required maxLength={MAX_SHORT_DESCRIPTION} value={fields.shortDescription} onChange={(e) => set("shortDescription", e.target.value)} />
      </label>
      <label className="field">
        <span>Description longue</span>
        <textarea
          required
          rows={5}
          maxLength={MAX_LONG_DESCRIPTION}
          value={fields.longDescription}
          onChange={(e) => set("longDescription", e.target.value)}
        />
      </label>
      {DATES.map(({ key, label }) => (
        <label key={key} className="field">
          <span>{label}</span>
          <input type="date" required value={fields[key]} onChange={(e) => set(key, e.target.value)} />
        </label>
      ))}
      <div className="row-actions">
        <button type="submit" className="btn primary" disabled={busy}>
          {project ? "Enregistrer" : "Créer"}
        </button>
        <button type="button" className="btn ghost" onClick={onClose}>
          Annuler
        </button>
      </div>
      <p className="muted small">
        {"La communication commence au plus tard le jour de l'événement ; la billetterie ouvre au plus tard le jour de sa fermeture."}
      </p>
    </form>
  );
}

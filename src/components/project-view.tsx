"use client";

import { useEffect, useEffectEvent, useState } from "react";
import { TaskCard } from "@/components/task-card";
import { TaskForm } from "@/components/task-form";
import type { Run } from "@/components/team-panel";
import { api, post } from "@/lib/client/api";
import { formatDay, plural } from "@/lib/client/format";
import type { Project, ProjectDetail } from "@/lib/shared/planning";

/**
 * Page d'un projet : ses informations, ses tâches et leurs inscriptions, l'ajout d'une tâche.
 * version change après chaque action : le projet est relu. onLoadFailed : erreur de droits ou de session (gérée par le parent).
 */
export function ProjectView({
  id,
  version,
  busy,
  run,
  onBack,
  onEdit,
  onLoadFailed,
}: {
  id: string;
  version: number;
  busy: boolean;
  run: Run;
  onBack: () => void;
  onEdit: (project: Project) => void;
  onLoadFailed: (err: unknown) => void;
}) {
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState("");
  const loadFailed = useEffectEvent((err: unknown) => {
    setError((err as Error).message);
    onLoadFailed(err);
  });

  useEffect(() => {
    let ignore = false;
    api<ProjectDetail>(`/api/projects?id=${encodeURIComponent(id)}`)
      .then((d) => {
        if (ignore) return;
        setDetail(d);
        setError("");
      })
      .catch((err: unknown) => {
        if (!ignore) loadFailed(err);
      });
    return () => {
      ignore = true;
    };
  }, [id, version]);

  const shown = detail?.project.id === id ? detail : null;

  function remove(project: Project): void {
    if (!window.confirm(`Supprimer le projet « ${project.title} » et ses ${plural(project.tasks, "tâche")} ?`)) return;
    void run(async () => {
      await post("/api/projects", { id: project.id }, "DELETE");
      onBack();
    });
  }

  if (!shown) {
    return (
      <div className="card">
        <button type="button" className="btn ghost small" onClick={onBack}>
          Retour au calendrier
        </button>
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : (
          <p className="muted">Chargement du projet…</p>
        )}
      </div>
    );
  }

  const { project, tasks, members, me, role } = shown;
  return (
    <>
      <section className="card project">
        <div className="table-head">
          <button type="button" className="btn ghost small" onClick={onBack}>
            Retour au calendrier
          </button>
          {role === "admin" && (
            <div className="row-actions">
              <button type="button" className="btn small" disabled={busy} onClick={() => onEdit(project)}>
                Modifier
              </button>
              <button type="button" className="btn ghost danger small" disabled={busy} onClick={() => remove(project)}>
                Supprimer
              </button>
            </div>
          )}
        </div>
        <p className="eyebrow">{formatDay(project.eventDate)}</p>
        <h2>{project.title}</h2>
        <p className="project-short">{project.shortDescription}</p>
        <p className="project-long">{project.longDescription}</p>
        <dl className="data-list">
          <dt>Événement</dt>
          <dd>{formatDay(project.eventDate)}</dd>
          <dt>Début de la communication</dt>
          <dd>{formatDay(project.communicationStart)}</dd>
          <dt>Ouverture de la billetterie</dt>
          <dd>{formatDay(project.ticketingOpen)}</dd>
          <dt>Fermeture de la billetterie</dt>
          <dd>{formatDay(project.ticketingClose)}</dd>
        </dl>
      </section>

      <section className="card">
        <div className="table-head">
          <h2>{`Tâches · ${project.tasksDone}/${project.tasks} faites`}</h2>
        </div>
        {tasks.length ? (
          <ul className="tasks">
            {tasks.map((task) => (
              <TaskCard key={task.id} projectId={project.id} task={task} members={members} me={me} role={role} busy={busy} run={run} />
            ))}
          </ul>
        ) : (
          <p className="muted">Aucune tâche pour l&apos;instant.</p>
        )}
      </section>

      <TaskForm key={project.id} projectId={project.id} task={null} busy={busy} run={run} />
    </>
  );
}

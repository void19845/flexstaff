"use client";

import { useState } from "react";
import { TaskForm } from "@/components/task-form";
import type { Run } from "@/components/team-panel";
import { post } from "@/lib/client/api";
import { formatShortDay } from "@/lib/client/format";
import type { PlanningMember, Task } from "@/lib/shared/planning";
import type { Role } from "@/lib/shared/types";

/** Nom affiché d'une personne inscrite : son e-mail, signalé s'il a quitté l'équipe. */
function memberLabel(members: PlanningMember[], userId: string): string {
  const m = members.find((x) => x.userId === userId);
  if (!m) return "Compte inconnu";
  return m.role === null ? `${m.email} (ancien membre)` : m.email;
}

/**
 * Une tâche : cochage (personnes inscrites et admins), inscriptions (chacun pour soi, les admins pour tout membre),
 * modification et suppression (admins).
 */
export function TaskCard({
  projectId,
  task,
  members,
  me,
  role,
  busy,
  run,
}: {
  projectId: string;
  task: Task;
  members: PlanningMember[];
  me: string;
  role: Role;
  busy: boolean;
  run: Run;
}) {
  const [editing, setEditing] = useState(false);
  const [pick, setPick] = useState("");
  const isAdmin = role === "admin";
  const mine = task.assignees.includes(me);
  const candidates = members.filter((m) => m.role !== null && !task.assignees.includes(m.userId));

  const setDone = (done: boolean): void => void run(() => post("/api/tasks", { id: task.id, done }, "PATCH"));
  const assign = (userId?: string): void => void run(() => post("/api/tasks/assignees", { taskId: task.id, userId }));
  const unassign = (userId?: string): void => void run(() => post("/api/tasks/assignees", { taskId: task.id, userId }, "DELETE"));

  function remove(): void {
    if (!window.confirm(`Supprimer la tâche « ${task.title} » ?`)) return;
    void run(() => post("/api/tasks", { id: task.id }, "DELETE"));
  }

  if (editing) {
    return (
      <li className="task">
        <TaskForm projectId={projectId} task={task} busy={busy} run={run} onClose={() => setEditing(false)} />
      </li>
    );
  }

  return (
    <li className={`task${task.done ? " done" : ""}`}>
      <label className="check task-title">
        <input
          type="checkbox"
          checked={task.done}
          disabled={busy || !(isAdmin || mine)}
          onChange={(e) => setDone(e.target.checked)}
          title={isAdmin || mine ? undefined : "Inscris-toi sur la tâche pour la cocher"}
        />
        <strong>{task.title}</strong>
      </label>
      {task.dueDate && <p className="muted small">{`Échéance : ${formatShortDay(task.dueDate)}`}</p>}
      {task.description && <p className="task-description">{task.description}</p>}

      <ul className="chips" aria-label="Personnes inscrites">
        {task.assignees.map((userId) => (
          <li key={userId} className={`chip${userId === me ? " you" : ""}`}>
            {memberLabel(members, userId)}
            {isAdmin && userId !== me && (
              <button type="button" className="btn link" disabled={busy} onClick={() => unassign(userId)}>
                Retirer
              </button>
            )}
          </li>
        ))}
        {!task.assignees.length && <li className="muted small">Personne pour l&apos;instant</li>}
      </ul>

      <div className="row-actions">
        {mine ? (
          <button type="button" className="btn ghost small" disabled={busy} onClick={() => unassign()}>
            Me retirer
          </button>
        ) : (
          <button type="button" className="btn primary small" disabled={busy} onClick={() => assign()}>
            {"Je m'en charge"}
          </button>
        )}
        {isAdmin && (
          <>
            <select className="small-select" aria-label="Membre à inscrire" value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Inscrire un membre…</option>
              {candidates.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.email}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn small"
              disabled={busy || !pick}
              onClick={() => {
                assign(pick);
                setPick("");
              }}
            >
              Inscrire
            </button>
            <button type="button" className="btn ghost small" disabled={busy} onClick={() => setEditing(true)}>
              Modifier
            </button>
            <button type="button" className="btn ghost danger small" disabled={busy} onClick={remove}>
              Supprimer
            </button>
          </>
        )}
      </div>
    </li>
  );
}

"use client";

import { useState, type FormEvent } from "react";
import type { Run } from "@/components/team-panel";
import { post } from "@/lib/client/api";
import { MAX_TASK_DESCRIPTION, MAX_TASK_TITLE, type Task } from "@/lib/shared/planning";

/** Ajout d'une tâche à un projet (toute l'équipe), ou modification d'une tâche (task, admins). Échéance facultative. */
export function TaskForm({
  projectId,
  task,
  busy,
  run,
  onClose,
}: {
  projectId: string;
  task: Task | null;
  busy: boolean;
  run: Run;
  onClose?: () => void;
}) {
  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [dueDate, setDueDate] = useState(task?.dueDate ?? "");

  function submit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    void run(async () => {
      const fields = { title, description, dueDate: dueDate || null };
      if (task) {
        await post("/api/tasks", { id: task.id, ...fields }, "PATCH");
        onClose?.();
      } else {
        await post("/api/tasks", { projectId, ...fields });
        setTitle("");
        setDescription("");
        setDueDate("");
      }
    });
  }

  return (
    <form className={task ? "task-form" : "task-form card"} onSubmit={submit}>
      {!task && <h3>Ajouter une tâche</h3>}
      <label className="field">
        <span>Titre</span>
        <input required maxLength={MAX_TASK_TITLE} value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="field">
        <span>Description</span>
        <textarea rows={3} maxLength={MAX_TASK_DESCRIPTION} placeholder="Facultative" value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="field">
        <span>Échéance</span>
        <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
      </label>
      <div className="row-actions">
        <button type="submit" className="btn primary small" disabled={busy}>
          {task ? "Enregistrer" : "Ajouter"}
        </button>
        {onClose && (
          <button type="button" className="btn ghost small" onClick={onClose}>
            Annuler
          </button>
        )}
      </div>
    </form>
  );
}

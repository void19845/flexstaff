"use client";

import { formatDay, formatMonth } from "@/lib/client/format";
import type { Project } from "@/lib/shared/planning";

/** Ce qu'un jour du calendrier affiche pour un projet : l'événement lui-même ou l'une de ses étapes */
type Kind = "event" | "com" | "open" | "close";

interface Entry {
  kind: Kind;
  project: Project;
}

const KIND_SHORT: Record<Kind, string> = { event: "", com: "Com", open: "Ouv.", close: "Ferm." };
const KIND_LABEL: Record<Kind, string> = {
  event: "Événement",
  com: "Début de la communication",
  open: "Ouverture de la billetterie",
  close: "Fermeture de la billetterie",
};
const WEEKDAYS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];

const pad = (n: number): string => String(n).padStart(2, "0");
const isoDay = (year: number, month: number, day: number): string => `${year}-${pad(month + 1)}-${pad(day)}`;

/** Entrées de chaque jour (AAAA-MM-JJ), événements d'abord. */
function entriesByDay(projects: Project[]): Map<string, Entry[]> {
  const days = new Map<string, Entry[]>();
  const add = (day: string, entry: Entry): void => {
    days.set(day, [...(days.get(day) ?? []), entry]);
  };
  for (const kind of ["event", "com", "open", "close"] as const) {
    for (const project of projects) {
      const day = { event: project.eventDate, com: project.communicationStart, open: project.ticketingOpen, close: project.ticketingClose }[kind];
      add(day, { kind, project });
    }
  }
  return days;
}

function EntryButton({ entry, full, onOpen }: { entry: Entry; full: boolean; onOpen: (id: string) => void }) {
  const { kind, project } = entry;
  return (
    <button
      type="button"
      className={`cal-entry kind-${kind}`}
      title={`${KIND_LABEL[kind]} : ${project.title}`}
      onClick={() => onOpen(project.id)}
    >
      {kind !== "event" && <span className="cal-kind">{full ? KIND_LABEL[kind] : KIND_SHORT[kind]}</span>}
      <span className="cal-title">{project.title}</span>
    </button>
  );
}

/**
 * Calendrier d'un mois (semaines du lundi au dimanche) : chaque projet le jour de son événement, et ses étapes
 * (communication, billetterie). Sur téléphone, une liste des jours du mois qui ont quelque chose remplace la grille.
 * today : AAAA-MM-JJ, lu par le parent hors du rendu.
 */
export function PlanningCalendar({
  projects,
  year,
  month,
  today,
  onMonth,
  onOpen,
}: {
  projects: Project[];
  year: number;
  month: number;
  today: string | null;
  onMonth: (year: number, month: number) => void;
  onOpen: (id: string) => void;
}) {
  const days = entriesByDay(projects);
  const firstWeekday = (new Date(Date.UTC(year, month, 1)).getUTCDay() + 6) % 7;
  const length = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const cells: (number | null)[] = [...Array<null>(firstWeekday).fill(null), ...Array.from({ length }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  const monthDays = Array.from({ length }, (_, i) => isoDay(year, month, i + 1)).filter((d) => days.has(d));
  const go = (delta: number): void => {
    const d = new Date(Date.UTC(year, month + delta, 1));
    onMonth(d.getUTCFullYear(), d.getUTCMonth());
  };

  return (
    <section className="card cal" aria-labelledby="cal-title">
      <div className="table-head">
        <h2 id="cal-title" className="cal-month">
          {formatMonth(year, month)}
        </h2>
        <div className="row-actions">
          <button type="button" className="btn ghost small" onClick={() => go(-1)}>
            Mois précédent
          </button>
          {today && (
            <button type="button" className="btn ghost small" onClick={() => onMonth(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1)}>
              {"Aujourd'hui"}
            </button>
          )}
          <button type="button" className="btn ghost small" onClick={() => go(1)}>
            Mois suivant
          </button>
        </div>
      </div>

      <div className="cal-grid" role="table" aria-label={`Calendrier de ${formatMonth(year, month)}`}>
        <div className="cal-row" role="row">
          {WEEKDAYS.map((d) => (
            <div key={d} className="cal-weekday" role="columnheader">
              {d}
            </div>
          ))}
        </div>
        {Array.from({ length: cells.length / 7 }, (_, w) => (
          <div key={w} className="cal-row" role="row">
            {cells.slice(w * 7, w * 7 + 7).map((day, i) => {
              if (day === null) return <div key={i} className="cal-day out" role="cell" />;
              const iso = isoDay(year, month, day);
              return (
                <div key={i} className={`cal-day${iso === today ? " today" : ""}`} role="cell">
                  <span className="cal-date">{day}</span>
                  {(days.get(iso) ?? []).map((entry) => (
                    <EntryButton key={`${entry.kind}-${entry.project.id}`} entry={entry} full={false} onOpen={onOpen} />
                  ))}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div className="cal-list">
        {monthDays.length ? (
          <ol>
            {monthDays.map((iso) => (
              <li key={iso} className={iso === today ? "today" : undefined}>
                <p className="cal-list-day">{formatDay(iso)}</p>
                {(days.get(iso) ?? []).map((entry) => (
                  <EntryButton key={`${entry.kind}-${entry.project.id}`} entry={entry} full onOpen={onOpen} />
                ))}
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">Rien de prévu ce mois-ci.</p>
        )}
      </div>

      <p className="legend muted small">
        <span className="cal-entry kind-event">Événement</span>
        <span className="cal-entry kind-com">
          <span className="cal-kind">Com</span> début de la communication
        </span>
        <span className="cal-entry kind-open">
          <span className="cal-kind">Ouv.</span> ouverture de la billetterie
        </span>
        <span className="cal-entry kind-close">
          <span className="cal-kind">Ferm.</span> fermeture de la billetterie
        </span>
      </p>
    </section>
  );
}

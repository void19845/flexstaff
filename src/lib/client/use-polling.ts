"use client";

import { useCallback, useEffect, useRef } from "react";
import { isAuthError } from "./api";

export interface PollingHandlers<T> {
  /** startedAt : heure de départ de la requête, pour ignorer une réponse plus ancienne qu'une action locale */
  onState: (state: T, startedAt: number) => void;
  onStatus?: (connected: boolean) => void;
  /** Session ou droits refusés (401 / 403) : l'interrogation s'arrête. */
  onUnauthorized?: () => void;
}

/**
 * Interroge le serveur à intervalle régulier (les fonctions Vercel ne gardent pas de connexion ouverte).
 * Ralentit (x5) quand l'onglet est en arrière-plan et repart tout de suite quand il revient au premier plan.
 * Les fonctions passées peuvent changer à chaque rendu : seule la dernière version est utilisée.
 * Renvoie refresh(), pour rafraîchir tout de suite après une action.
 */
export function usePolling<T>(
  fetchState: () => Promise<T>,
  intervalMs: number,
  handlers: PollingHandlers<T>,
  enabled = true,
): () => void {
  const fetchRef = useRef(fetchState);
  const handlersRef = useRef(handlers);
  useEffect(() => {
    fetchRef.current = fetchState;
    handlersRef.current = handlers;
  });
  const scheduleRef = useRef<(delay: number) => void>(() => undefined);

  useEffect(() => {
    if (!enabled) return;
    let timer: number | undefined;
    let stopped = false;
    let inFlight = false;

    const schedule = (delay: number): void => {
      window.clearTimeout(timer);
      if (!stopped) timer = window.setTimeout(tick, delay);
    };

    async function tick(): Promise<void> {
      if (stopped || inFlight) return;
      inFlight = true;
      const startedAt = Date.now();
      try {
        const state = await fetchRef.current();
        if (stopped) return;
        handlersRef.current.onStatus?.(true);
        handlersRef.current.onState(state, startedAt);
      } catch (err) {
        if (stopped) return;
        if (isAuthError(err)) {
          stopped = true;
          handlersRef.current.onUnauthorized?.();
          return;
        }
        handlersRef.current.onStatus?.(false);
      } finally {
        inFlight = false;
      }
      schedule(document.hidden ? intervalMs * 5 : intervalMs);
    }

    const onVisible = (): void => {
      if (!document.hidden) schedule(0);
    };
    document.addEventListener("visibilitychange", onVisible);
    scheduleRef.current = schedule;
    schedule(0);

    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      scheduleRef.current = () => undefined;
    };
  }, [enabled, intervalMs]);

  return useCallback(() => scheduleRef.current(0), []);
}

"use client";

import jsQR from "jsqr";
import Link from "next/link";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { LoginForm } from "@/components/login-form";
import { StaffPollCard } from "@/components/staff-poll-card";
import { currentAccount, signOut } from "@/lib/client/account";
import { api, isAuthError, post } from "@/lib/client/api";
import { dateTimeFmt, formatCode } from "@/lib/client/format";
import { usePolling } from "@/lib/client/use-polling";
import type { Me, RewardCheck, StaffPoll } from "@/lib/shared/types";

/** Lecteur de QR intégré au navigateur (Chrome, Android). Absent sur Safari : on passe alors par jsQR. */
interface QrDetector {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
type DetectorClass = new (options: { formats: string[] }) => QrDetector;

/**
 * Écran affiché. login : connexion, avec un message éventuel (id change à chaque retour : formulaire recréé) ;
 * scanner : compte avec un rôle dans Flexform ; denied : compte connecté sans rôle dans Flexform.
 */
type View = { name: "login"; message: string; id: number } | { name: "scanner"; me: Me } | { name: "denied"; me: Me };

function toLogin(message: string): (view: View | null) => View {
  return (view) => ({ name: "login", message, id: view?.name === "login" ? view.id + 1 : 0 });
}

const signedIn = (me: Me): View => (me.staffPage ? { name: "scanner", me } : { name: "denied", me });

/** Page /staff : remise des récompenses de Flexform et sondages réservés au staff (admin et staff de Flexform). */
export function RewardsApp() {
  const [view, setView] = useState<View | null>(null);

  useEffect(() => {
    let ignore = false;
    currentAccount()
      .then((me) => {
        if (!ignore) setView(me ? signedIn(me) : toLogin(""));
      })
      .catch((err: unknown) => {
        if (!ignore) setView(toLogin((err as Error).message));
      });
    return () => {
      ignore = true;
    };
  }, []);

  if (!view) return null;
  if (view.name === "login") {
    return (
      <LoginForm
        key={view.id}
        title="Remise des récompenses"
        intro="Scanne les QR codes des récompenses gagnées dans les sondages du BDE."
        note="Réservé au staff et aux admins de Flexform."
        message={view.message}
        onSignedIn={(me) => setView(signedIn(me))}
      />
    );
  }
  if (view.name === "denied") return <Denied me={view.me} onSignedOut={() => setView(toLogin(""))} />;
  return (
    <Scanner
      me={view.me}
      onSignedOut={() => setView(toLogin(""))}
      onUnauthorized={(message) => setView(toLogin(message))}
    />
  );
}

/** Compte connecté à Flexstaff (admin d'une autre appli) sans rôle dans Flexform. */
function Denied({ me, onSignedOut }: { me: Me; onSignedOut: () => void }) {
  return (
    <div className="card login">
      <p className="eyebrow">Flex Suite</p>
      <h1>Remise des récompenses</h1>
      <p className="muted">{`Le compte ${me.email} n'a pas de rôle admin ou staff dans Flexform.`}</p>
      <div className="actions">
        {me.apps.length > 0 && (
          <Link className="btn primary" href="/">
            Gérer les équipes
          </Link>
        )}
        <button type="button" className="btn ghost" onClick={() => void signOut().then(onSignedOut)}>
          Déconnexion
        </button>
      </div>
    </div>
  );
}

// --- Scanner --------------------------------------------------------------

const AIM_HINT = "Vise le QR code affiché sur le téléphone du participant.";

/** Zone de résultat : vérification en cours, erreur, ou réponse du serveur (redeeming : validation en cours d'envoi). */
type Result = { kind: "checking" } | { kind: "error"; message: string } | { kind: "reward"; r: RewardCheck; redeeming?: boolean };

function Scanner({ me, onSignedOut, onUnauthorized }: { me: Me; onSignedOut: () => void; onUnauthorized: (message: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  /** Scan en pause pendant l'affichage d'un résultat, pour ne pas relire le même code en boucle */
  const paused = useRef(false);
  /** starting : en attente de l'accès à la caméra ; on : image affichée et scan en cours */
  const [camera, setCamera] = useState<"off" | "starting" | "on">("off");
  const [hint, setHint] = useState(AIM_HINT);
  const [result, setResult] = useState<Result | null>(null);
  const [input, setInput] = useState("");

  function toggleCamera(): void {
    if (camera === "on") setCamera("off");
    else if (!navigator.mediaDevices?.getUserMedia) {
      setHint("Caméra indisponible ici (il faut une adresse en https). Utilise la saisie manuelle.");
    } else setCamera("starting");
  }

  function logout(): void {
    setCamera("off");
    void signOut().then(onSignedOut);
  }

  function next(): void {
    paused.current = false;
    setInput("");
    setResult(null);
  }

  /** Envoie le code au serveur et affiche sa réponse. */
  async function check(code: string): Promise<void> {
    paused.current = true;
    setResult({ kind: "checking" });
    try {
      setResult({ kind: "reward", r: await post<RewardCheck>("/api/staff/check", { code }) });
    } catch (err) {
      failed(err);
    }
  }

  async function redeem(r: RewardCheck): Promise<void> {
    setResult({ kind: "reward", r, redeeming: true });
    try {
      setResult({ kind: "reward", r: await post<RewardCheck>("/api/staff/redeem", { code: r.code }) });
    } catch (err) {
      failed(err);
    }
  }

  /** Session expirée ou accès retiré : retour à la connexion. La caméra s'arrête avec le démontage du scanner. */
  function failed(err: unknown): void {
    if (isAuthError(err)) onUnauthorized(err.message);
    else setResult({ kind: "error", message: (err as Error).message });
  }

  const onScan = useEffectEvent((text: string) => {
    navigator.vibrate?.(80);
    return check(text);
  });

  // Caméra allumée : flux vidéo, puis lecture d'une image toutes les 200 ms. Tout s'arrête quand la caméra
  // est coupée (bouton, déconnexion) ou quand le scanner disparaît.
  const cameraWanted = camera !== "off";
  useEffect(() => {
    const video = videoRef.current;
    if (!cameraWanted || !video) return;
    const canvas = document.createElement("canvas");
    const Detector = (window as unknown as { BarcodeDetector?: DetectorClass }).BarcodeDetector;
    const detector = Detector ? new Detector({ formats: ["qr_code"] }) : null;
    let stream: MediaStream | null = null;
    let timer: number | undefined;
    let stopped = false;

    async function scan(): Promise<void> {
      if (!paused.current) {
        const text = await readFrame(video!, canvas, detector);
        if (text && !paused.current && !stopped) await onScan(text);
      }
      if (!stopped) timer = window.setTimeout(scan, 200);
    }

    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false }).then(
      async (s) => {
        // Caméra coupée pendant la demande d'accès
        if (stopped) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        video.srcObject = s;
        setCamera("on");
        setHint(AIM_HINT);
        await video.play().catch(() => undefined);
        if (!stopped) timer = window.setTimeout(scan, 200);
      },
      () => {
        if (stopped) return;
        setHint("Accès à la caméra refusé. Autorise-la dans le navigateur, ou utilise la saisie manuelle.");
        setCamera("off");
      },
    );

    return () => {
      stopped = true;
      window.clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    };
  }, [cameraWanted]);

  return (
    <>
      <header className="topbar">
        <div>
          <p className="eyebrow">BDE Montreuil · Staff</p>
          <h1>Remise des récompenses</h1>
        </div>
        <div className="topbar-actions">
          {me.apps.length > 0 && (
            <Link className="btn ghost small" href="/">
              Équipe
            </Link>
          )}
          <button type="button" className="btn ghost small" onClick={logout}>
            Déconnexion
          </button>
        </div>
      </header>
      <StaffPolls onUnauthorized={() => onUnauthorized("Session expirée ou accès retiré, reconnecte-toi.")} />
      <div className="card scanner">
        <div className="video-box">
          <video ref={videoRef} playsInline muted autoPlay hidden={camera !== "on"} />
        </div>
        <button type="button" className={camera === "on" ? "btn ghost big" : "btn primary big"} onClick={toggleCamera}>
          {camera === "on" ? "Arrêter la caméra" : "Activer la caméra"}
        </button>
        <p className="muted small">{hint}</p>
      </div>
      <section className="scan-result" aria-live="polite">
        {result?.kind === "checking" && (
          <div className="card result">
            <p className="muted">Vérification…</p>
          </div>
        )}
        {result?.kind === "error" && (
          <div className="card result invalid">
            <h2>Erreur</h2>
            <p>{result.message}</p>
            <button type="button" className="btn big" onClick={next}>
              Réessayer
            </button>
          </div>
        )}
        {result?.kind === "reward" && (
          <RewardCard r={result.r} redeeming={!!result.redeeming} onRedeem={() => void redeem(result.r)} onNext={next} />
        )}
      </section>
      <div className="card">
        <h2>Saisie manuelle</h2>
        <p className="muted small">Si le scan ne marche pas, tape le code écrit sous le QR.</p>
        <form
          className="manual"
          onSubmit={(e) => {
            e.preventDefault();
            if (input.trim()) void check(input);
          }}
        >
          <input
            type="text"
            placeholder="ABCD-EFGH-JKLM"
            autoComplete="off"
            aria-label="Code de la récompense"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button type="submit" className="btn">
            Vérifier
          </button>
        </form>
      </div>
    </>
  );
}

// --- Sondages réservés au staff ---------------------------------------------

/** Sondages ouverts au staff, cachés s'il n'y en a aucun. */
function StaffPolls({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [polled, setPolled] = useState<{ polls: StaffPoll[]; startedAt: number } | null>(null);
  const refresh = usePolling(() => api<StaffPoll[]>("/api/staff/polls"), 10000, {
    onState: (polls, startedAt) => setPolled({ polls, startedAt }),
    onUnauthorized,
  });

  if (!polled?.polls.length) return null;
  return (
    <section className="hub">
      <h2 className="hub-title">Sondages du staff</h2>
      <p className="muted">Visibles seulement par le staff. Tu peux changer ta réponse tant que le sondage est ouvert.</p>
      <div className="hub-list">
        {polled.polls.map((p) => (
          <StaffPollCard key={p.id} poll={p} startedAt={polled.startedAt} onVoted={refresh} />
        ))}
      </div>
    </section>
  );
}

const TITLES: Record<RewardCheck["status"], string> = {
  valid: "Récompense valide",
  done: "Remise validée",
  used: "Déjà utilisée",
  invalid: "Code invalide",
};

/** Réponse du serveur pour un code : récompense, personne, sondage, et les boutons pour valider ou passer au suivant. */
function RewardCard({
  r,
  redeeming,
  onRedeem,
  onNext,
}: {
  r: RewardCheck;
  redeeming: boolean;
  onRedeem: () => void;
  onNext: () => void;
}) {
  const person = r.person && (r.person.prenom || r.person.nom || r.person.pseudo) ? r.person : null;
  return (
    <div className={`card result ${r.status}`}>
      <h2>{TITLES[r.status]}</h2>
      {r.reward && <p className="reward-text">{r.reward}</p>}
      {person && (
        <p className="person">
          <strong>{[person.prenom, person.nom.toUpperCase()].filter(Boolean).join(" ") || person.pseudo}</strong>
          <span className="muted">{[person.formation, person.pseudo && `@${person.pseudo}`].filter(Boolean).join(" · ")}</span>
        </p>
      )}
      {r.question && <p className="muted small">{`Sondage : ${r.question}`}</p>}
      {r.status === "used" && r.redeemedAt ? (
        <p>{`Remise le ${dateTimeFmt.format(r.redeemedAt)}. Ne pas la redonner.`}</p>
      ) : null}
      {r.message && <p>{r.message}</p>}
      <p className="muted small code">{formatCode(r.code)}</p>
      {r.status === "valid" && (
        <button type="button" className="btn primary big" disabled={redeeming} onClick={onRedeem}>
          Valider la remise
        </button>
      )}
      <button type="button" className={r.status === "valid" ? "btn ghost big" : "btn big"} onClick={onNext}>
        {r.status === "valid" ? "Annuler" : "Scanner le suivant"}
      </button>
    </div>
  );
}

/** Lit le QR code de l'image affichée par la caméra, ou null s'il n'y en a pas. */
async function readFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement, detector: QrDetector | null): Promise<string | null> {
  if (video.readyState < 2 || !video.videoWidth) return null;
  if (detector) {
    const codes = await detector.detect(video).catch(() => []);
    return codes[0]?.rawValue ?? null;
  }
  // Image réduite : jsQR est bien plus rapide et lit toujours un QR affiché sur un écran
  const scale = Math.min(1, 640 / video.videoWidth);
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return jsQR(data, width, height)?.data ?? null;
}

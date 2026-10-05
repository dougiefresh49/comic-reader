"use client";

import { useState, useRef, useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { PAUSE_TO_HOOK_STEP } from "~/app/api/admin/cancel-ingest/hooks";
import { STEP_ORDER } from "~/lib/pipeline-steps";

export interface SkippedGate {
  gate?: string;
  reason?: string;
  counts?: unknown;
  at?: string;
}

interface PipelineActionsProps {
  bookId: string;
  issueId: string;
  pipelineStep: string | null;
  pipelinePaused: boolean;
  pipelinePausedAt: string | null;
  pipelinePausedUrl: string | null;
  pageCount: number;
  status: string;
  skippedGates?: SkippedGate[];
}

const REVIEW_STEPS: Record<string, string> = {
  "review-clusters": "Characters",
  "review-pages": "Review Pages",
  casting: "Voices",
};

const STEP_LABELS: Record<string, string> = {
  queued: "Queued",
  "roboflow-page-analyze": "Analyze pages",
  "fetch-wiki-context": "Fetch wiki",
  "character-lookahead": "Character lookahead",
  "review-clusters": "Characters",
  "get-context": "Get context",
  "sort-page-elements": "Sort elements",
  "review-pages": "Page review",
  "generate-voice-descriptions": "Voice descriptions",
  casting: "Voices",
  "generate-audio": "Generate audio",
  "generate-manifest": "Generate manifest",
  "extract-foreground-masks": "Extract masks",
  complete: "Complete",
};

function toRelativePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** Masks retry only on a complete issue (trigger-ingest answers 409 otherwise), so a failed issue never offers them. */
const MASKS_STEP = "extract-foreground-masks";

function nextStepAfter(pausedAt: string | null): string | null {
  if (!pausedAt) return null;
  // Restarting after casting would run audio without the voices check.
  if (pausedAt === "casting") return "casting";
  const idx = (STEP_ORDER as readonly string[]).indexOf(pausedAt);
  if (idx < 0) return pausedAt;
  return STEP_ORDER[idx + 1] ?? pausedAt;
}

export interface TriggerRefusal {
  error: string;
  runId?: string;
}

/** Reads a non-OK trigger-ingest response. A 409 names the live run that blocked it. */
export async function readTriggerRefusal(
  res: Response,
): Promise<TriggerRefusal> {
  const fallback = `Failed to start (HTTP ${res.status})`;
  try {
    const data = (await res.json()) as { error?: string; runId?: string };
    return {
      error: data.error ?? fallback,
      runId: res.status === 409 ? data.runId : undefined,
    };
  } catch {
    return { error: fallback };
  }
}

export function TriggerRefusalNotice({
  bookId,
  issueId,
  refusal,
  onCancelled,
  onCancellingChange,
}: {
  bookId: string;
  issueId: string;
  refusal: TriggerRefusal;
  onCancelled: () => void;
  /** Callers disable their trigger buttons while a cancel is in flight. */
  onCancellingChange: (cancelling: boolean) => void;
}) {
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCancel() {
    setCancelling(true);
    onCancellingChange(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/cancel-ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookId, issueId, runId: refusal.runId }),
      });
      if (res.ok) {
        onCancelled();
        return;
      }
      let message = "Failed to cancel";
      try {
        const data = (await res.json()) as { error?: string };
        if (data.error) message = data.error;
      } catch {
        /* keep default */
      }
      setError(message);
    } finally {
      setCancelling(false);
      onCancellingChange(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <span className="max-w-xs text-xs text-red-400">{refusal.error}</span>
      {refusal.runId && (
        <button
          onClick={handleCancel}
          disabled={cancelling}
          className="rounded bg-red-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-600 disabled:opacity-50"
        >
          {cancelling ? "..." : `Cancel run ${refusal.runId}`}
        </button>
      )}
      {error && <span className="max-w-xs text-xs text-red-400">{error}</span>}
    </span>
  );
}

export function PipelineActions({
  bookId,
  issueId,
  pipelineStep,
  pipelinePaused,
  pipelinePausedAt,
  pipelinePausedUrl,
  pageCount,
  status,
  skippedGates,
}: PipelineActionsProps) {
  const [loading, setLoading] = useState(false);
  const [triggered, setTriggered] = useState(false);
  const [refusal, setRefusal] = useState<TriggerRefusal | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const router = useRouter();
  const busy = loading || cancelling;

  const isFailed = pipelineStep?.startsWith("failed:") ?? false;
  const failedStep = isFailed
    ? (pipelineStep ?? "").replace("failed:", "")
    : null;

  const canStart =
    pageCount > 0 && (!pipelineStep || pipelineStep === "pages-downloaded");

  const isComplete = pipelineStep === "complete";
  const isRunning =
    !canStart &&
    !isComplete &&
    !isFailed &&
    !pipelinePaused &&
    pipelineStep !== null;
  const isPaused = pipelinePaused && pipelinePausedAt !== null;

  async function handleTrigger(fromStep?: string) {
    setLoading(true);
    setRefusal(null);
    try {
      const res = await fetch("/api/admin/trigger-ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookId, issueId, fromStep }),
      });
      if (res.ok) {
        setTriggered(true);
      } else {
        setRefusal(await readTriggerRefusal(res));
      }
    } finally {
      setLoading(false);
    }
  }

  // The wrapper renders unconditionally so `actions` keeps its tree position
  // and PausedActions' local state survives a refusal appearing.
  const withRefusal = (actions: ReactNode) => (
    <span className="inline-flex flex-col items-start gap-1">
      {actions}
      {refusal && (
        <TriggerRefusalNotice
          bookId={bookId}
          issueId={issueId}
          refusal={refusal}
          onCancelled={() => {
            setRefusal(null);
            router.refresh();
          }}
          onCancellingChange={setCancelling}
        />
      )}
    </span>
  );

  if (triggered) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded bg-emerald-700/30 px-2.5 py-1 text-xs font-medium text-emerald-300">
        <Spinner /> Queued
      </span>
    );
  }

  if (canStart) {
    return withRefusal(
      <button
        onClick={() => handleTrigger()}
        disabled={busy}
        className="rounded bg-amber-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-600 disabled:opacity-50"
      >
        {loading ? "..." : "Start Pipeline"}
      </button>,
    );
  }

  if (isFailed && failedStep) {
    return withRefusal(
      <FailedActions
        failedStep={failedStep}
        loading={busy}
        onTrigger={handleTrigger}
      />,
    );
  }

  if (isPaused) {
    return withRefusal(
      <PausedActions
        bookId={bookId}
        issueId={issueId}
        pipelinePausedAt={pipelinePausedAt}
        pipelinePausedUrl={pipelinePausedUrl}
        status={status}
        triggerLoading={busy}
        onTrigger={handleTrigger}
        onSettled={() => router.refresh()}
      />,
    );
  }

  if (isRunning) {
    const label = STEP_LABELS[pipelineStep ?? ""] ?? pipelineStep;
    const skippedLabels = (skippedGates ?? [])
      .map((s) => s.gate)
      .filter((g): g is string => typeof g === "string" && g.length > 0);
    return (
      <span className="inline-flex flex-col gap-0.5">
        <span className="inline-flex items-center gap-1.5 rounded bg-cyan-700/30 px-2.5 py-1 text-xs font-medium text-cyan-300">
          <Spinner /> {label}
        </span>
        {skippedLabels.length > 0 && (
          <span className="text-[10px] text-neutral-500">
            skipped: {skippedLabels.join(", ")}
          </span>
        )}
      </span>
    );
  }

  if (isComplete) {
    return (
      <a
        href={`/book/${bookId}/${issueId}/1`}
        className="rounded bg-emerald-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-600"
      >
        Read &rarr;
      </a>
    );
  }

  return <span className="text-xs text-neutral-600">—</span>;
}

function PausedActions({
  bookId,
  issueId,
  pipelinePausedAt,
  pipelinePausedUrl,
  status,
  triggerLoading,
  onTrigger,
  onSettled,
}: {
  bookId: string;
  issueId: string;
  pipelinePausedAt: string | null;
  pipelinePausedUrl: string | null;
  status: string;
  triggerLoading: boolean;
  onTrigger: (fromStep?: string) => void;
  onSettled: () => void;
}) {
  const [loading, setLoading] = useState<"resume" | "cancel" | null>(null);
  const [resumeMissing, setResumeMissing] = useState(false);
  const [resumed, setResumed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const label = REVIEW_STEPS[pipelinePausedAt ?? ""] ?? "Review";
  const nextStep = nextStepAfter(pipelinePausedAt);
  const offerRestart = status !== "ready" && nextStep !== null;
  const busy = loading !== null || triggerLoading;

  async function handleResume() {
    if (!pipelinePausedAt) return;
    const hookStep = PAUSE_TO_HOOK_STEP[pipelinePausedAt] ?? pipelinePausedAt;
    setLoading("resume");
    setError(null);
    try {
      const res = await fetch("/api/admin/resume-hook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bookId,
          issueId,
          step: hookStep,
        }),
      });
      if (res.status === 404) {
        setResumeMissing(true);
        return;
      }
      if (res.ok) {
        setResumed(true);
        return;
      }
      let message = "Failed to resume";
      try {
        const data = (await res.json()) as { error?: string };
        if (data.error) message = data.error;
      } catch {
        /* keep default */
      }
      setError(message);
    } finally {
      setLoading(null);
    }
  }

  async function handleCancel() {
    setLoading("cancel");
    setError(null);
    try {
      const res = await fetch("/api/admin/cancel-ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookId, issueId }),
      });
      if (res.ok) {
        onSettled();
        return;
      }
      let message = "Failed to cancel";
      try {
        const data = (await res.json()) as { error?: string };
        if (data.error) message = data.error;
      } catch {
        /* keep default */
      }
      setError(message);
    } finally {
      setLoading(null);
    }
  }

  function handleRestart() {
    if (!nextStep) return;
    const ok = window.confirm(
      `Restart from ${nextStep}? This starts a new run and re-runs paid steps.`,
    );
    if (!ok) return;
    onTrigger(nextStep);
  }

  if (resumed) {
    return (
      <span className="inline-flex items-center rounded bg-emerald-700/30 px-2.5 py-1 text-xs font-medium text-emerald-300">
        Resumed
      </span>
    );
  }

  if (resumeMissing) {
    return (
      <span className="inline-flex flex-col items-start gap-1">
        <span className="text-xs text-amber-300">
          No live run for this pause
        </span>
        {offerRestart && (
          <button
            onClick={handleRestart}
            disabled={busy}
            className="rounded bg-amber-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-600 disabled:opacity-50"
          >
            Restart from {nextStep}
          </button>
        )}
        {error && (
          <span className="max-w-xs text-xs text-red-400">{error}</span>
        )}
      </span>
    );
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <span className="inline-flex flex-wrap items-center gap-1.5">
        {pipelinePausedUrl && (
          <a
            href={toRelativePath(pipelinePausedUrl)}
            className="rounded bg-yellow-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-yellow-500"
          >
            {label} &rarr;
          </a>
        )}
        <button
          onClick={handleResume}
          disabled={busy}
          className="rounded bg-emerald-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
        >
          {loading === "resume" ? "..." : "Resume"}
        </button>
        <button
          onClick={handleCancel}
          disabled={busy}
          className="rounded bg-red-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-600 disabled:opacity-50"
        >
          {loading === "cancel" ? "..." : "Cancel"}
        </button>
      </span>
      {error && <span className="max-w-xs text-xs text-red-400">{error}</span>}
    </span>
  );
}

function FailedActions({
  failedStep,
  loading,
  onTrigger,
}: {
  failedStep: string;
  loading: boolean;
  onTrigger: (fromStep?: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [menuOpen]);

  const failedLabel = STEP_LABELS[failedStep] ?? failedStep;
  const failedIdx = (STEP_ORDER as readonly string[]).indexOf(failedStep);

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setMenuOpen(!menuOpen)}
        disabled={loading}
        className="flex items-center gap-1.5 rounded bg-red-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-600 disabled:opacity-50"
        title={`Failed at: ${failedLabel}`}
      >
        {loading ? (
          "..."
        ) : (
          <>
            Retry: {failedLabel}{" "}
            <span className="text-red-300/70">{menuOpen ? "▴" : "▾"}</span>
          </>
        )}
      </button>
      {menuOpen && (
        <div className="fixed inset-0 z-40 md:hidden" aria-hidden="true" />
      )}
      {menuOpen && (
        <div className="fixed inset-x-3 bottom-3 z-50 max-h-[70vh] overflow-y-auto rounded-xl border border-neutral-700 bg-neutral-800 py-1 shadow-2xl md:absolute md:inset-auto md:top-full md:right-0 md:bottom-auto md:mt-1 md:w-56 md:rounded-lg">
          <div className="flex items-center justify-between px-3 py-2 md:py-1.5">
            <span className="text-[10px] font-medium tracking-wide text-neutral-500 uppercase">
              Restart from step
            </span>
            <button
              onClick={() => setMenuOpen(false)}
              className="rounded p-1 text-neutral-500 hover:bg-neutral-700 hover:text-neutral-300 md:hidden"
            >
              ✕
            </button>
          </div>
          <button
            onClick={() => {
              setMenuOpen(false);
              onTrigger();
            }}
            className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-neutral-200 hover:bg-neutral-700 md:py-1.5 md:text-xs"
          >
            <span className="text-amber-400">↻</span> Start from beginning
          </button>
          <div className="my-1 border-t border-neutral-700" />
          {failedStep !== MASKS_STEP && (
            <>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  onTrigger(failedStep);
                }}
                className="flex w-full items-center gap-2 bg-red-900/30 px-3 py-2.5 text-left text-sm font-medium text-red-300 hover:bg-red-900/50 md:py-1.5 md:text-xs"
              >
                <span className="text-red-400">▶</span> Retry: {failedLabel}
              </button>
              <div className="my-1 border-t border-neutral-700" />
            </>
          )}
          {STEP_ORDER.filter((step) => step !== MASKS_STEP).map((step, idx) => {
            const stepLabel = STEP_LABELS[step] ?? step;
            const isFailedStep = step === failedStep;
            return (
              <button
                key={step}
                onClick={() => {
                  setMenuOpen(false);
                  onTrigger(step);
                }}
                className={`flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm hover:bg-neutral-700 md:py-1.5 md:text-xs ${
                  isFailedStep
                    ? "font-medium text-red-300"
                    : idx < failedIdx
                      ? "text-neutral-400"
                      : "text-neutral-200"
                }`}
              >
                {isFailedStep && <span className="text-red-400">✗</span>}
                {!isFailedStep && idx < failedIdx && (
                  <span className="text-emerald-500">✓</span>
                )}
                {!isFailedStep && idx > failedIdx && (
                  <span className="text-neutral-600">○</span>
                )}
                {stepLabel}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

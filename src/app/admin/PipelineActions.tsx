"use client";

import { useState, useRef, useEffect } from "react";

interface PipelineActionsProps {
  bookId: string;
  issueId: string;
  pipelineStep: string | null;
  pipelinePaused: boolean;
  pipelinePausedAt: string | null;
  pipelinePausedUrl: string | null;
  pageCount: number;
}

const REVIEW_STEPS: Record<string, string> = {
  "review-clusters": "Review Clusters",
  "review-pages": "Review Pages",
  "review-new-characters": "Review Characters",
  casting: "Review Casting",
};

const STEP_LABELS: Record<string, string> = {
  queued: "Queued",
  "roboflow-page-analyze": "Analyze pages",
  "extract-foreground-masks": "Extract masks",
  "fetch-wiki-context": "Fetch wiki",
  "character-lookahead": "Character lookahead",
  "review-clusters": "Cluster review",
  "get-context": "Get context",
  "sort-page-elements": "Sort elements",
  "review-pages": "Page review",
  "generate-voice-descriptions": "Voice descriptions",
  "review-new-characters": "Character review",
  casting: "Casting",
  "generate-voice-models": "Generate voices",
  "generate-audio": "Generate audio",
  "upload-audio": "Upload audio",
  "consolidate-music-scenes": "Music scenes",
  "generate-manifest": "Generate manifest",
  complete: "Complete",
};

const STEP_ORDER = [
  "roboflow-page-analyze",
  "extract-foreground-masks",
  "fetch-wiki-context",
  "character-lookahead",
  "review-clusters",
  "get-context",
  "sort-page-elements",
  "review-pages",
  "generate-voice-descriptions",
  "review-new-characters",
  "casting",
  "generate-voice-models",
  "generate-audio",
  "upload-audio",
  "consolidate-music-scenes",
  "generate-manifest",
];

function toRelativePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export function PipelineActions({
  bookId,
  issueId,
  pipelineStep,
  pipelinePaused,
  pipelinePausedAt,
  pipelinePausedUrl,
  pageCount,
}: PipelineActionsProps) {
  const [loading, setLoading] = useState(false);
  const [triggered, setTriggered] = useState(false);

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
    try {
      const res = await fetch("/api/admin/trigger-ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookId, issueId, fromStep }),
      });
      if (res.ok) setTriggered(true);
    } finally {
      setLoading(false);
    }
  }

  if (triggered) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded bg-emerald-700/30 px-2.5 py-1 text-xs font-medium text-emerald-300">
        <Spinner /> Queued
      </span>
    );
  }

  if (canStart) {
    return (
      <button
        onClick={() => handleTrigger()}
        disabled={loading}
        className="rounded bg-amber-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-600 disabled:opacity-50"
      >
        {loading ? "..." : "Start Pipeline"}
      </button>
    );
  }

  if (isFailed && failedStep) {
    return (
      <FailedActions
        failedStep={failedStep}
        loading={loading}
        onTrigger={handleTrigger}
      />
    );
  }

  if (isPaused && pipelinePausedUrl) {
    const label = REVIEW_STEPS[pipelinePausedAt ?? ""] ?? "Review";
    return (
      <a
        href={toRelativePath(pipelinePausedUrl)}
        className="rounded bg-yellow-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-yellow-500"
      >
        {label} &rarr;
      </a>
    );
  }

  if (isRunning) {
    const label = STEP_LABELS[pipelineStep ?? ""] ?? pipelineStep;
    return (
      <span className="inline-flex items-center gap-1.5 rounded bg-cyan-700/30 px-2.5 py-1 text-xs font-medium text-cyan-300">
        <Spinner /> {label}
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
  const failedIdx = STEP_ORDER.indexOf(failedStep);

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
          {STEP_ORDER.map((step, idx) => {
            const label = STEP_LABELS[step] ?? step;
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
                {label}
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

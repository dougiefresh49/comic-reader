import { formatDuration } from "./format";
import type { RowStatus, StageView, StepView } from "./model";

/** One row per stage; the open ones list their steps with durations. */
export function Stages({ stages }: { stages: StageView[] }) {
  return (
    <ol className="divide-y divide-neutral-800 overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900/40">
      {stages.map((stage, i) => (
        <StageRow key={stage.stage} stage={stage} index={i + 1} />
      ))}
    </ol>
  );
}

function StageRow({ stage, index }: { stage: StageView; index: number }) {
  const active =
    stage.status === "running" ||
    stage.status === "waiting" ||
    stage.status === "failed";
  const muted = stage.status === "pending";

  return (
    <li>
      <details open={active} className="group">
        <summary className="grid cursor-pointer list-none grid-cols-[1.25rem_1fr_auto] items-center gap-x-4 px-5 py-3.5 select-none hover:bg-neutral-900/70 [&::-webkit-details-marker]:hidden">
          <Marker status={stage.status} size="lg" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-3">
              <span
                className={`text-base font-medium ${muted ? "text-neutral-500" : "text-neutral-100"}`}
              >
                <span className="mr-2 text-neutral-600 tabular-nums">
                  {index}
                </span>
                {stage.label}
              </span>
              <StatusWord status={stage.status} />
            </div>
            {stage.result && (
              <p className="mt-0.5 text-sm text-neutral-400">{stage.result}</p>
            )}
          </div>
          <div className="flex items-center gap-3 text-sm text-neutral-400 tabular-nums">
            {stage.durationMs !== null && (
              <span>{formatDuration(stage.durationMs)}</span>
            )}
            <Chevron />
          </div>
        </summary>
        <ul className="border-t border-neutral-800/70 bg-neutral-950/50 py-1.5">
          {stage.steps.map((step) => (
            <StepRow key={step.step} step={step} />
          ))}
        </ul>
      </details>
    </li>
  );
}

function StepRow({ step }: { step: StepView }) {
  const muted = step.status === "pending";
  return (
    <li className="grid grid-cols-[1.25rem_1fr_auto] items-baseline gap-x-4 px-5 py-1.5 text-sm">
      <Marker status={step.status} size="sm" />
      <div className="min-w-0">
        <span className={muted ? "text-neutral-500" : "text-neutral-200"}>
          {step.label}
        </span>
        {step.detail && (
          <span className="ml-3 text-neutral-400">{step.detail}</span>
        )}
      </div>
      <span className="text-neutral-500 tabular-nums">
        {step.durationMs !== null &&
          `${formatDuration(step.durationMs)}${step.unfinished ? " (unfinished)" : ""}`}
      </span>
    </li>
  );
}

const STATUS_WORDS: Record<RowStatus, string | null> = {
  done: null,
  skipped: "skipped",
  running: "running",
  waiting: "waiting on you",
  failed: "failed",
  cancelled: "cancelled",
  pending: null,
};

const STATUS_WORD_COLORS: Record<RowStatus, string> = {
  done: "",
  skipped: "text-neutral-500",
  running: "text-cyan-300",
  waiting: "text-amber-300",
  failed: "text-red-300",
  cancelled: "text-neutral-400",
  pending: "",
};

function StatusWord({ status }: { status: RowStatus }) {
  const word = STATUS_WORDS[status];
  if (!word) return null;
  return (
    <span className={`text-sm ${STATUS_WORD_COLORS[status]}`}>{word}</span>
  );
}

/** A status mark drawn with CSS and one SVG check, no emoji. */
export function Marker({
  status,
  size,
}: {
  status: RowStatus;
  size: "sm" | "lg";
}) {
  const box = size === "lg" ? "size-5" : "size-3.5";
  const base = `relative flex ${box} shrink-0 items-center justify-center rounded-full self-center`;

  switch (status) {
    case "done":
      return (
        <span className={`${base} bg-neutral-200 text-neutral-950`}>
          <Check size={size} />
        </span>
      );
    case "skipped":
      return (
        <span
          className={`${base} border border-dashed border-neutral-500`}
          aria-label="skipped"
        />
      );
    case "running":
      return (
        <span className={base} aria-label="running">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-cyan-400/40" />
          <span
            className={`relative inline-flex ${size === "lg" ? "size-3" : "size-2"} rounded-full bg-cyan-400`}
          />
        </span>
      );
    case "waiting":
      return (
        <span
          className={`${base} border-2 border-amber-400 bg-amber-400/20`}
          aria-label="waiting on you"
        />
      );
    case "failed":
      return (
        <span className={`${base} bg-red-500 text-neutral-950`}>
          <Cross size={size} />
        </span>
      );
    case "cancelled":
      return (
        <span className={`${base} bg-neutral-500 text-neutral-950`}>
          <Cross size={size} />
        </span>
      );
    case "pending":
      return (
        <span
          className={`${base} border border-neutral-700`}
          aria-label="not started"
        />
      );
  }
}

function Check({ size }: { size: "sm" | "lg" }) {
  const px = size === "lg" ? 12 : 9;
  return (
    <svg
      width={px}
      height={px}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 6.5l2.5 2.5 4.5-5" />
    </svg>
  );
}

function Cross({ size }: { size: "sm" | "lg" }) {
  const px = size === "lg" ? 11 : 8;
  return (
    <svg
      width={px}
      height={px}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M3 3l6 6M9 3l-6 6" />
    </svg>
  );
}

function Chevron() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="text-neutral-500 transition-transform group-open:rotate-180"
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

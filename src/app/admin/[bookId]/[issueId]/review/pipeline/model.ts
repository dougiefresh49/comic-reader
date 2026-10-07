/**
 * Turns the issue row, the latest run and the row counts into what the hub
 * draws: one state word, the current step, and one view per stage and step.
 * Pure functions; the page computes `now` once and passes it in.
 */
import {
  STEP_ORDER,
  isPipelineStep,
  isUnstartedStep,
  type PipelineStep,
} from "~/lib/pipeline-steps";
import type { PipelineReviewIssue } from "~/server/admin/pipeline-review";
import type {
  PipelineRun,
  ProgressCounts,
} from "~/server/admin/pipeline-progress";
import { formatDuration, plural } from "./format";
import {
  GATE_STEPS,
  STAGES,
  STAGE_BLURBS,
  STAGE_LABELS,
  STEP_LABELS,
  stepsOfStage,
  type Stage,
} from "./stages";

export type RunState =
  | "running"
  | "waiting"
  | "failed"
  | "cancelled"
  | "ready"
  | "not-started";

export const STATE_LABELS: Record<RunState, string> = {
  running: "Running",
  waiting: "Waiting on you",
  failed: "Failed",
  cancelled: "Cancelled",
  ready: "Ready",
  "not-started": "Not started",
};

/** The Run fact: one word that agrees with the headline, never the raw DB status. */
export const RUN_WORDS: Record<RunState, string> = {
  running: "Running",
  waiting: "Paused",
  failed: "Failed",
  cancelled: "Cancelled",
  ready: "Completed",
  "not-started": "Not started",
};

/**
 * The admin dashboard's badge per state. `word: null` shows the raw
 * `issues.status`. The dashboard has no run row, so "cancelled" never comes
 * up there; a cancelled run reads "Failed", as it did before #484.
 */
export const DASHBOARD_BADGES: Record<
  RunState,
  { word: string | null; className: string }
> = {
  waiting: {
    word: "Paused",
    className:
      "shrink-0 rounded bg-yellow-700/30 px-2 py-0.5 text-xs font-medium text-yellow-300",
  },
  ready: {
    word: "Ready",
    className:
      "shrink-0 rounded bg-emerald-700/30 px-2 py-0.5 text-xs font-medium text-emerald-300",
  },
  failed: {
    word: "Failed",
    className:
      "rounded bg-red-700/30 px-2 py-0.5 text-xs font-medium text-red-300",
  },
  cancelled: {
    word: "Failed",
    className:
      "rounded bg-red-700/30 px-2 py-0.5 text-xs font-medium text-red-300",
  },
  running: {
    word: "Running",
    className:
      "rounded bg-cyan-700/30 px-2 py-0.5 text-xs font-medium text-cyan-300",
  },
  "not-started": {
    word: null,
    className:
      "shrink-0 rounded bg-neutral-700/30 px-2 py-0.5 text-xs font-medium text-neutral-400",
  },
};

/** Poll interval per state: fast while a step works, slow while the hub waits for a button or a person, none when done. */
const REFRESH_MS: Record<RunState, number | null> = {
  running: 5000,
  waiting: 15000,
  failed: 15000,
  cancelled: 15000,
  "not-started": 15000,
  ready: null,
};

export type RowStatus =
  | "done"
  | "skipped"
  | "running"
  | "waiting"
  | "failed"
  | "cancelled"
  | "pending";

export interface StepView {
  step: PipelineStep;
  label: string;
  status: RowStatus;
  /** null when this run has no timing for the step (an older run, or a restart). */
  durationMs: number | null;
  /** A window opened and never closed while the step is no longer current. */
  unfinished: boolean;
  detail: string | null;
}

export interface StageView {
  stage: Stage;
  label: string;
  status: RowStatus;
  durationMs: number | null;
  result: string | null;
  steps: StepView[];
}

export interface HubView {
  state: RunState;
  /** Label of the step the run is on, failed at, or paused at. */
  currentLabel: string | null;
  /** The headline's second line: what the run is doing right now. */
  summary: string;
  startedAt: string | null;
  /** Run wall clock: to `completed_at`, or to now while the row is running. */
  durationMs: number | null;
  /** How long the owner has had the open gate. */
  waitingMs: number | null;
  stages: StageView[];
  /** How often the page re-fetches itself; null once the run is done. */
  refreshMs: number | null;
  /** The Run fact's word: RUN_WORDS for the state, but "Running" while masks still run on a ready issue. */
  runWord: string;
}

/**
 * Live states win over `issues.status`, because nothing resets `status` when
 * a ready issue re-runs: a re-run from casting is "waiting", not "ready".
 * A cancel leaves `pipeline_step` at `failed:<step>`; the run row tells the
 * two apart. The admin dashboard reads its badge from this too (#484).
 */
export function runState(
  issue: Pick<
    PipelineReviewIssue,
    "status" | "pipelineStep" | "pipelinePaused" | "pipelinePausedAt"
  >,
  run: PipelineRun | null,
): RunState {
  const step = issue.pipelineStep;
  if (step?.startsWith("failed:")) {
    return run?.status === "cancelled" ? "cancelled" : "failed";
  }
  if (issue.pipelinePaused && issue.pipelinePausedAt) return "waiting";
  if (step && isPipelineStep(step)) return "running";
  if (step === "complete" || issue.status === "ready") return "ready";
  if (isUnstartedStep(step)) return "not-started";
  return "running";
}

function currentStepOf(
  issue: PipelineReviewIssue,
  state: RunState,
): string | null {
  switch (state) {
    case "failed":
    case "cancelled":
      return (issue.pipelineStep ?? "").replace(/^failed:/, "") || null;
    case "waiting":
      return issue.pipelinePausedAt;
    case "running":
      return issue.pipelineStep;
    default:
      return null;
  }
}

/** Index of the current step in STEP_ORDER; -1 before the first, STEP_ORDER.length after the last. */
function cursorOf(state: RunState, currentStep: string | null): number {
  if (state === "ready") return STEP_ORDER.length;
  if (state === "not-started" || currentStep === null) return -1;
  return isPipelineStep(currentStep) ? STEP_ORDER.indexOf(currentStep) : -1;
}

interface Timing {
  /** null when the only window is open and nothing can end it. */
  ms: number | null;
  open: boolean;
}

/**
 * Sum of the step's windows in this run. An open window ends at the run's
 * `completed_at` when it has one (a failed or cancelled run), at `now` only
 * when `live` (the step a running run is on right now), and otherwise adds
 * nothing, so a dead run's timer never climbs on a poll.
 */
function stepTiming(
  run: PipelineRun | null,
  step: PipelineStep,
  now: number,
  live: boolean,
): Timing | null {
  const windows = run?.timings[step];
  if (!windows || windows.length === 0) return null;
  const openEnd = run?.completedAt
    ? new Date(run.completedAt).getTime()
    : live
      ? now
      : null;
  let ms: number | null = null;
  let open = false;
  for (const w of windows) {
    const start = new Date(w.startedAt).getTime();
    if (Number.isNaN(start)) continue;
    if (w.endedAt) {
      ms = (ms ?? 0) + Math.max(0, new Date(w.endedAt).getTime() - start);
    } else {
      open = true;
      if (openEnd !== null) ms = (ms ?? 0) + Math.max(0, openEnd - start);
    }
  }
  return { ms, open };
}

function ratio(done: number, total: number, unit: string): string {
  return `${done} of ${total} ${unit}`;
}

/** The step's progress as one SELECT-backed line; null when it has no countable unit. */
function stepProgress(step: PipelineStep, c: ProgressCounts): string | null {
  switch (step) {
    case "roboflow-page-analyze":
      return ratio(c.pagesWithPanels, c.pages, "pages have panels");
    case "review-clusters":
      return c.faces === 0
        ? "no faces found"
        : ratio(c.facesNamed, c.faces, "faces named");
    case "get-context":
      return ratio(c.bubblesWithSpeaker, c.bubbles, "bubbles have a speaker");
    case "word-geometry":
      return ratio(
        c.wordGeometryDone,
        c.wordGeometryCandidates,
        "bubbles have word boxes",
      );
    case "casting":
      return c.castingTasks > 0
        ? ratio(c.castingTasksDone, c.castingTasks, "casting tasks done")
        : `${c.castlist} ${plural(c.castlist, "speaker")} in the castlist`;
    case "generate-audio":
      return ratio(
        c.bubblesWithAudio,
        c.spokenBubbles,
        "spoken bubbles have audio",
      );
    case "extract-foreground-masks":
      return ratio(c.panelsWithMasks, c.panels, "panels have masks");
    default:
      return null;
  }
}

function stageResult(
  stage: Stage,
  c: ProgressCounts,
  skipReason: string | null,
): string {
  switch (stage) {
    case "detect":
      return `${c.panels} ${plural(c.panels, "panel")} on ${c.pagesWithPanels} of ${c.pages} pages`;
    case "characters":
      if (skipReason) return `Skipped: ${skipReason}`;
      return c.faces === 0
        ? "No faces found"
        : `${c.facesNamed} of ${c.faces} faces named`;
    case "read":
      return `${c.bubblesWithSpeaker} of ${c.bubbles} bubbles have a speaker`;
    case "pages":
      return `${c.bubbles} ${plural(c.bubbles, "bubble")} on ${c.pages} ${plural(c.pages, "page")}`;
    case "voices-audio":
      return `${c.bubblesWithAudio} of ${c.spokenBubbles} spoken bubbles have audio, ${c.castlistWithVoice} of ${c.castlist} speakers have a voice`;
    case "ready":
      return `${c.panelsWithMasks} of ${c.panels} panels have masks`;
  }
}

function stageStatus(steps: StepView[]): RowStatus {
  if (steps.some((s) => s.status === "failed")) return "failed";
  if (steps.some((s) => s.status === "cancelled")) return "cancelled";
  if (steps.some((s) => s.status === "waiting")) return "waiting";
  if (steps.some((s) => s.status === "running")) return "running";
  if (steps.every((s) => s.status === "skipped")) return "skipped";
  if (steps.every((s) => s.status === "done" || s.status === "skipped")) {
    return "done";
  }
  return "pending";
}

export function buildHubView(
  issue: PipelineReviewIssue,
  run: PipelineRun | null,
  counts: ProgressCounts,
  now: number,
): HubView {
  const state = runState(issue, run);
  // Masks run after the issue is ready (#356): while the latest run row is
  // still open, the masks row is live and the page keeps polling.
  const masksRunning = state === "ready" && run?.status === "running";
  const currentStep = currentStepOf(issue, state);
  const cursor = cursorOf(state, currentStep);
  const currentLabel = currentStep
    ? isPipelineStep(currentStep)
      ? STEP_LABELS[currentStep]
      : currentStep
    : null;

  const skipReasons = new Map(run?.skipped.map((s) => [s.gate, s.reason]));
  const openWait =
    state === "waiting"
      ? run?.gateWaits.find(
          (w) => w.gate === currentStep && w.releasedAt === undefined,
        )
      : undefined;
  const waitingMs = openWait
    ? Math.max(0, now - new Date(openWait.waitedAt).getTime())
    : null;

  const stages: StageView[] = STAGES.map((stage) => {
    const steps: StepView[] = stepsOfStage(stage).map((step) => {
      const index = STEP_ORDER.indexOf(step);
      const timing = stepTiming(
        run,
        step,
        now,
        (state === "running" && step === currentStep) ||
          (masksRunning && step === "extract-foreground-masks"),
      );

      let status: RowStatus;
      if (step === "extract-foreground-masks" && run?.masksError) {
        // Masks run after ready, so the cursor has passed them; only the
        // run row knows they failed (#356).
        status = "failed";
      } else if (step === "extract-foreground-masks" && masksRunning) {
        status = "running";
      } else if (index < cursor) {
        status = skipReasons.has(step) ? "skipped" : "done";
      } else if (index === cursor) {
        status =
          state === "failed" ||
          state === "cancelled" ||
          state === "waiting" ||
          state === "running"
            ? state
            : "pending";
      } else {
        status = "pending";
      }

      const parts: string[] = [];
      if (status === "skipped") {
        parts.push(`skipped: ${skipReasons.get(step)}`);
      } else if (step === "extract-foreground-masks" && run?.masksError) {
        parts.push(`failed: ${run.masksError}`);
      } else if (status !== "pending") {
        const progress = stepProgress(step, counts);
        if (progress) parts.push(progress);
      }
      if (GATE_STEPS.has(step) && run) {
        for (const w of run.gateWaits) {
          if (w.gate !== step) continue;
          if (w.releasedAt) {
            parts.push(
              `you took ${formatDuration(new Date(w.releasedAt).getTime() - new Date(w.waitedAt).getTime())}`,
            );
          } else if (status === "waiting") {
            parts.push(
              `waiting on you for ${formatDuration(now - new Date(w.waitedAt).getTime())}`,
            );
          }
        }
      }

      return {
        step,
        label: STEP_LABELS[step],
        status,
        durationMs: timing?.ms ?? null,
        unfinished: (timing?.open ?? false) && status !== "running",
        detail: parts.length > 0 ? parts.join(" · ") : null,
      };
    });

    const status = stageStatus(steps);
    const timed = steps.filter((s) => s.durationMs !== null);
    const gateSkip = steps.find((s) => s.status === "skipped");
    return {
      stage,
      label: STAGE_LABELS[stage],
      status,
      durationMs:
        timed.length > 0
          ? timed.reduce((sum, s) => sum + (s.durationMs ?? 0), 0)
          : null,
      result:
        status === "pending"
          ? STAGE_BLURBS[stage]
          : stageResult(
              stage,
              counts,
              gateSkip ? (skipReasons.get(gateSkip.step) ?? null) : null,
            ),
      steps,
    };
  });

  const startedAt = run?.startedAt ?? null;
  let durationMs: number | null = null;
  if (startedAt) {
    const start = new Date(startedAt).getTime();
    if (run?.completedAt) {
      durationMs = Math.max(0, new Date(run.completedAt).getTime() - start);
    } else if (run?.status === "running") {
      durationMs = Math.max(0, now - start);
    }
  }

  const currentTiming =
    currentStep && isPipelineStep(currentStep)
      ? stepTiming(run, currentStep, now, state === "running")
      : null;
  const currentProgress =
    currentStep && isPipelineStep(currentStep)
      ? stepProgress(currentStep, counts)
      : null;

  let summary: string;
  switch (state) {
    case "running":
      summary = [
        `${currentLabel ?? "Starting"}${currentTiming?.ms !== null && currentTiming?.ms !== undefined ? ` for ${formatDuration(currentTiming.ms)}` : ""}`,
        currentProgress,
      ]
        .filter(Boolean)
        .join(" · ");
      break;
    case "waiting":
      summary = `Paused at ${currentLabel}${waitingMs !== null ? ` for ${formatDuration(waitingMs)}` : ""}. Nothing moves until you finish there and resume.`;
      break;
    case "failed":
      summary = `Failed at ${currentLabel}. Earlier steps keep their rows; a retry starts from this step.`;
      break;
    case "cancelled":
      summary = `Cancelled at ${currentLabel}. Earlier steps keep their rows; a retry starts from this step.`;
      break;
    case "ready":
      summary = `The issue plays in the reader${run?.completedAt && durationMs !== null ? `; the last run took ${formatDuration(durationMs)}` : ""}.${run?.masksError ? " Foreground masks failed on that run, so pages play without them." : masksRunning ? " Foreground masks are still running." : ""}`;
      break;
    case "not-started":
      summary =
        counts.pages > 0
          ? `${counts.pages} ${plural(counts.pages, "page")} uploaded. Starting finds the panels, text and faces.`
          : "No pages uploaded yet.";
      break;
  }

  return {
    state,
    currentLabel,
    summary,
    startedAt,
    durationMs,
    waitingMs,
    stages,
    refreshMs: masksRunning ? REFRESH_MS.running : REFRESH_MS[state],
    runWord: masksRunning ? RUN_WORDS.running : RUN_WORDS[state],
  };
}

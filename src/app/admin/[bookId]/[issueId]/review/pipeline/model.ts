/**
 * Turns the issue row, the latest run and the row counts into what the hub
 * draws: one state word, the current step, and one view per stage and step.
 * Pure functions; the page computes `now` once and passes it in.
 */
import type { PipelineReviewIssue } from "~/server/admin/pipeline-review";
import type {
  PipelineRun,
  ProgressCounts,
} from "~/server/admin/pipeline-progress";
import { formatDuration, plural } from "./format";
import {
  GATE_STEPS,
  PIPELINE_STEPS,
  STAGES,
  STAGE_LABELS,
  STEP_LABELS,
  isPipelineStep,
  stepsOfStage,
  type PipelineStep,
  type Stage,
} from "./stages";

export type RunState =
  | "running"
  | "waiting"
  | "failed"
  | "ready"
  | "not-started";

export const STATE_LABELS: Record<RunState, string> = {
  running: "Running",
  waiting: "Waiting on you",
  failed: "Failed",
  ready: "Ready",
  "not-started": "Not started",
};

export type RowStatus =
  | "done"
  | "skipped"
  | "running"
  | "waiting"
  | "failed"
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
  /** The step the run is on, failed at, or paused at. Raw when unknown. */
  currentStep: string | null;
  currentLabel: string | null;
  /** The headline's second line: what the run is doing right now. */
  summary: string;
  startedAt: string | null;
  /** Run wall clock: to `completed_at`, or to now while the row is running. */
  durationMs: number | null;
  /** How long the owner has had the open gate. */
  waitingMs: number | null;
  stages: StageView[];
  live: boolean;
}

export function runState(issue: PipelineReviewIssue): RunState {
  const step = issue.pipelineStep;
  if (step?.startsWith("failed:")) return "failed";
  if (step === "complete" || issue.status === "ready") return "ready";
  if (issue.pipelinePaused && issue.pipelinePausedAt) return "waiting";
  if (!step || step === "pages-downloaded") return "not-started";
  return "running";
}

function currentStepOf(
  issue: PipelineReviewIssue,
  state: RunState,
): string | null {
  switch (state) {
    case "failed":
      return (issue.pipelineStep ?? "").replace(/^failed:/, "") || null;
    case "waiting":
      return issue.pipelinePausedAt;
    case "running":
      return issue.pipelineStep;
    default:
      return null;
  }
}

/** Index of the current step in PIPELINE_STEPS; -1 before the first, 16 after the last. */
function cursorOf(state: RunState, currentStep: string | null): number {
  if (state === "ready") return PIPELINE_STEPS.length;
  if (state === "not-started" || currentStep === null) return -1;
  return isPipelineStep(currentStep) ? PIPELINE_STEPS.indexOf(currentStep) : -1;
}

interface Timing {
  ms: number;
  open: boolean;
}

/** Sum of the step's windows in this run; open windows count up to `now`. */
function stepTiming(
  run: PipelineRun | null,
  step: PipelineStep,
  now: number,
): Timing | null {
  const windows = run?.timings[step];
  if (!windows || windows.length === 0) return null;
  let ms = 0;
  let open = false;
  for (const w of windows) {
    const start = new Date(w.startedAt).getTime();
    if (Number.isNaN(start)) continue;
    if (w.endedAt) {
      ms += Math.max(0, new Date(w.endedAt).getTime() - start);
    } else {
      ms += Math.max(0, now - start);
      open = true;
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
    case "extract-foreground-masks":
      return ratio(c.panelsWithMasks, c.panels, "panels have masks");
    case "review-clusters":
      return c.faces === 0
        ? "no faces found"
        : ratio(c.facesNamed, c.faces, "faces named");
    case "get-context":
      return ratio(c.bubblesWithSpeaker, c.bubbles, "bubbles have a speaker");
    case "review-new-characters":
      return c.newCharactersPending === null
        ? null
        : `${c.newCharactersPending} new ${plural(c.newCharactersPending, "character")} pending`;
    case "casting":
      return c.castingTasks > 0
        ? ratio(c.castingTasksDone, c.castingTasks, "casting tasks done")
        : `${c.castlist} ${plural(c.castlist, "speaker")} in the castlist`;
    case "generate-voice-models":
      return ratio(c.castlistWithVoice, c.castlist, "speakers have a voice");
    case "generate-audio":
      return ratio(
        c.bubblesWithAudio,
        c.spokenBubbles,
        "spoken bubbles have audio",
      );
    case "consolidate-music-scenes":
      return `${c.musicScenes} music ${plural(c.musicScenes, "scene")}`;
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
    case "pages": {
      const base = `${c.bubbles} ${plural(c.bubbles, "bubble")} on ${c.pages} ${plural(c.pages, "page")}`;
      return c.newCharactersPending
        ? `${base}, ${c.newCharactersPending} new ${plural(c.newCharactersPending, "character")} pending`
        : base;
    }
    case "voices-audio":
      return `${c.bubblesWithAudio} of ${c.spokenBubbles} spoken bubbles have audio, ${c.castlistWithVoice} of ${c.castlist} speakers have a voice`;
    case "ready":
      return `${c.musicScenes} music ${plural(c.musicScenes, "scene")}`;
  }
}

function stageStatus(steps: StepView[]): RowStatus {
  if (steps.some((s) => s.status === "failed")) return "failed";
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
  const state = runState(issue);
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
      const index = PIPELINE_STEPS.indexOf(step);
      const timing = stepTiming(run, step, now);

      let status: RowStatus;
      if (index < cursor) {
        status = skipReasons.has(step) ? "skipped" : "done";
      } else if (index === cursor) {
        status =
          state === "failed"
            ? "failed"
            : state === "waiting"
              ? "waiting"
              : state === "running"
                ? "running"
                : "pending";
      } else {
        status = "pending";
      }

      const parts: string[] = [];
      if (status === "skipped") {
        parts.push(`skipped: ${skipReasons.get(step)}`);
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
          ? null
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
      ? stepTiming(run, currentStep, now)
      : null;
  const currentProgress =
    currentStep && isPipelineStep(currentStep)
      ? stepProgress(currentStep, counts)
      : null;

  let summary: string;
  switch (state) {
    case "running":
      summary = [
        `${currentLabel ?? "Starting"}${currentTiming ? ` for ${formatDuration(currentTiming.ms)}` : ""}`,
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
    case "ready":
      summary = run?.completedAt
        ? `All ${PIPELINE_STEPS.length} steps done${durationMs !== null ? ` in ${formatDuration(durationMs)}` : ""}. The issue plays in the reader.`
        : `All ${PIPELINE_STEPS.length} steps done. The issue plays in the reader.`;
      break;
    case "not-started":
      summary =
        counts.pages > 0
          ? `${counts.pages} ${plural(counts.pages, "page")} uploaded. Starting finds the panels, text and faces, then stops for you at Characters.`
          : "No pages uploaded yet.";
      break;
  }

  return {
    state,
    currentStep,
    currentLabel,
    summary,
    startedAt,
    durationMs,
    waitingMs,
    stages,
    live: state === "running",
  };
}

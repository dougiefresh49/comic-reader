/**
 * The ingest pipeline's steps, in run order. The workflow, the dashboard's
 * controls and the issue hub all read this one list (#334). Masks run last,
 * after the issue is marked ready, so nothing waits on them (#356).
 */
export const STEP_ORDER = [
  "roboflow-page-analyze",
  "fetch-wiki-context",
  "character-lookahead",
  "review-clusters",
  "get-context",
  "sort-page-elements",
  "review-pages",
  "word-geometry",
  "generate-voice-descriptions",
  "casting",
  "generate-audio",
  "generate-manifest",
  "extract-foreground-masks",
] as const;

export type PipelineStep = (typeof STEP_ORDER)[number];

export function isPipelineStep(value: string): value is PipelineStep {
  return (STEP_ORDER as readonly string[]).includes(value);
}

/**
 * Steps the workflow no longer runs, mapped to the step their work lives in
 * now (#356), so a retry of an old `failed:<step>` starts where that work is
 * done. A retry that lands on `casting` runs the voices check again.
 */
export const RETIRED_STEPS: Readonly<Record<string, PipelineStep>> = {
  "generate-voice-models": "casting",
  "review-new-characters": "generate-voice-descriptions",
  "upload-audio": "generate-manifest",
  "consolidate-music-scenes": "generate-manifest",
};

/**
 * The step a `fromStep` names: a current step is itself, a retired step is
 * the step that took over its work, anything else is null.
 */
export function resolvePipelineStep(value: string): PipelineStep | null {
  if (isPipelineStep(value)) return value;
  return Object.hasOwn(RETIRED_STEPS, value) ? RETIRED_STEPS[value]! : null;
}

/** A `pipeline_step` that means no run has started yet: none, or only pages downloaded (#319). */
export function isUnstartedStep(step: string | null): boolean {
  return !step || step === "pages-downloaded";
}

/** Whether Start Pipeline shows, the one rule the dashboard and the issue hub share (#319). */
export function canStartPipeline(issue: {
  pageCount: number;
  pipelineStep: string | null;
}): boolean {
  return issue.pageCount > 0 && isUnstartedStep(issue.pipelineStep);
}

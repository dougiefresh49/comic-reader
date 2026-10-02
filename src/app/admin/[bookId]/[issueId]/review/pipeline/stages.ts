/**
 * The hub's map from pipeline step to stage, and the labels for both.
 *
 * `STEP_STAGE` is typed as `Record<PipelineStep, Stage>`, so a step in
 * `PIPELINE_STEPS` without a stage fails `pnpm typecheck`. Until #334 O1 is
 * answered, `PIPELINE_STEPS` is a local copy of the workflow's STEP_ORDER;
 * it should become an import from a shared step list once that lands.
 */

// Waits on issue #334 O1: replace with an import from the shared step list.
export const PIPELINE_STEPS = [
  "roboflow-page-analyze",
  "extract-foreground-masks",
  "fetch-wiki-context",
  "character-lookahead",
  "review-clusters",
  "get-context",
  "sort-page-elements",
  "review-pages",
  "review-new-characters",
  "generate-voice-descriptions",
  "casting",
  "generate-voice-models",
  "generate-audio",
  "upload-audio",
  "consolidate-music-scenes",
  "generate-manifest",
] as const;

export type PipelineStep = (typeof PIPELINE_STEPS)[number];

export const STAGES = [
  "detect",
  "characters",
  "read",
  "pages",
  "voices-audio",
  "ready",
] as const;

export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  detect: "Detect",
  characters: "Characters",
  read: "Read",
  pages: "Pages",
  "voices-audio": "Voices and audio",
  ready: "Ready",
};

/** What the stage does, in one line, for the stage row before it has data. */
export const STAGE_BLURBS: Record<Stage, string> = {
  detect: "Finds panels, text and faces on every page.",
  characters: "You name the faces the run could not place.",
  read: "Reads every bubble and gives it a speaker and an emotion.",
  pages: "You check the pages; new characters wait here too.",
  "voices-audio": "Describes, casts and records a voice for every speaker.",
  ready: "Groups scenes for music and writes the reader manifest.",
};

export const STEP_STAGE: Record<PipelineStep, Stage> = {
  "roboflow-page-analyze": "detect",
  "extract-foreground-masks": "detect",
  "fetch-wiki-context": "detect",
  "character-lookahead": "detect",
  "review-clusters": "characters",
  "get-context": "read",
  "sort-page-elements": "read",
  "review-pages": "pages",
  "review-new-characters": "pages",
  "generate-voice-descriptions": "voices-audio",
  casting: "voices-audio",
  "generate-voice-models": "voices-audio",
  "generate-audio": "voices-audio",
  "upload-audio": "voices-audio",
  "consolidate-music-scenes": "ready",
  "generate-manifest": "ready",
};

export const STEP_LABELS: Record<PipelineStep, string> = {
  "roboflow-page-analyze": "Analyze pages",
  "extract-foreground-masks": "Extract masks",
  "fetch-wiki-context": "Fetch wiki context",
  "character-lookahead": "Character lookahead",
  "review-clusters": "Cluster review",
  "get-context": "Get context",
  "sort-page-elements": "Sort elements",
  "review-pages": "Page review",
  "review-new-characters": "New character review",
  "generate-voice-descriptions": "Voice descriptions",
  casting: "Casting",
  "generate-voice-models": "Generate voices",
  "generate-audio": "Generate audio",
  "upload-audio": "Upload audio",
  "consolidate-music-scenes": "Music scenes",
  "generate-manifest": "Generate manifest",
};

/** Steps that pause the run for the owner. */
export const GATE_STEPS: ReadonlySet<PipelineStep> = new Set<PipelineStep>([
  "review-clusters",
  "review-pages",
  "review-new-characters",
  "casting",
]);

export function isPipelineStep(value: string): value is PipelineStep {
  return (PIPELINE_STEPS as readonly string[]).includes(value);
}

export function stepsOfStage(stage: Stage): PipelineStep[] {
  return PIPELINE_STEPS.filter((step) => STEP_STAGE[step] === stage);
}

export function stepLabel(step: string): string {
  return isPipelineStep(step) ? STEP_LABELS[step] : step;
}

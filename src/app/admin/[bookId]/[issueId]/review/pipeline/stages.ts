/**
 * The hub's map from pipeline step to stage, and the labels for both.
 *
 * `STEP_STAGE` is typed as `Record<PipelineStep, Stage>`, so a step added to
 * `STEP_ORDER` in `~/lib/pipeline-steps` without a stage fails
 * `pnpm typecheck`.
 */
import {
  STEP_ORDER,
  isPipelineStep,
  type PipelineStep,
} from "~/lib/pipeline-steps";

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

export function stepsOfStage(stage: Stage): PipelineStep[] {
  return STEP_ORDER.filter((step) => STEP_STAGE[step] === stage);
}

export function stepLabel(step: string): string {
  return isPipelineStep(step) ? STEP_LABELS[step] : step;
}

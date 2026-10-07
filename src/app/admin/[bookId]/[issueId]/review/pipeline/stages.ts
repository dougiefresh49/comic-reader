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
  characters:
    "You confirm the cast and name the faces the run could not place.",
  read: "Reads every bubble and gives it a speaker and an emotion.",
  pages: "You check the pages and their speakers.",
  "voices-audio": "Describes, casts and records a voice for every speaker.",
  ready:
    "Writes the reader manifest, then cuts foreground masks; the issue plays before masks finish.",
};

export const STEP_STAGE: Record<PipelineStep, Stage> = {
  "roboflow-page-analyze": "detect",
  "fetch-wiki-context": "detect",
  "character-lookahead": "detect",
  "review-clusters": "characters",
  "get-context": "read",
  "sort-page-elements": "read",
  "review-pages": "pages",
  "word-geometry": "pages",
  "generate-voice-descriptions": "voices-audio",
  casting: "voices-audio",
  "generate-audio": "voices-audio",
  "generate-manifest": "ready",
  "extract-foreground-masks": "ready",
};

export const STEP_LABELS: Record<PipelineStep, string> = {
  "roboflow-page-analyze": "Analyze pages",
  "fetch-wiki-context": "Fetch wiki context",
  "character-lookahead": "Character lookahead",
  "review-clusters": "Characters",
  "get-context": "Get context",
  "sort-page-elements": "Sort elements",
  "review-pages": "Page review",
  "word-geometry": "Word boxes",
  "generate-voice-descriptions": "Voice descriptions",
  casting: "Voices",
  "generate-audio": "Generate audio",
  "generate-manifest": "Generate manifest",
  "extract-foreground-masks": "Extract masks",
};

/** Steps that pause the run for the owner. */
export const GATE_STEPS: ReadonlySet<PipelineStep> = new Set<PipelineStep>([
  "review-clusters",
  "review-pages",
  "casting",
]);

export function stepsOfStage(stage: Stage): PipelineStep[] {
  return STEP_ORDER.filter((step) => STEP_STAGE[step] === stage);
}

export function stepLabel(step: string): string {
  return isPipelineStep(step) ? STEP_LABELS[step] : step;
}

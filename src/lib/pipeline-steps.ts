/**
 * The ingest pipeline's steps, in run order. The workflow, the dashboard's
 * controls and the issue hub all read this one list (#334).
 */
export const STEP_ORDER = [
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

export type PipelineStep = (typeof STEP_ORDER)[number];

export function isPipelineStep(value: string): value is PipelineStep {
  return (STEP_ORDER as readonly string[]).includes(value);
}

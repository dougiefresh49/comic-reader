export const PAUSE_TO_HOOK_STEP: Record<string, string> = {
  "review-clusters": "cluster-review",
  "review-pages": "page-review",
  // Retired in #356; kept so cancel and trigger still find a run on the old
  // workflow that is paused at this gate.
  "review-new-characters": "character-review",
  casting: "casting",
};

export function ingestHookToken(
  bookId: string,
  issueId: string,
  pauseOrHookStep: string,
): string {
  const hookStep = PAUSE_TO_HOOK_STEP[pauseOrHookStep] ?? pauseOrHookStep;
  return `ingest:${bookId}/${issueId}/${hookStep}`;
}

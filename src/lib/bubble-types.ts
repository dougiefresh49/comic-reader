export const BUBBLE_TYPES = [
  "SPEECH",
  "NARRATION",
  "CAPTION",
  "SFX",
  "BACKGROUND",
] as const;

export type BubbleType = (typeof BUBBLE_TYPES)[number];

export const SPOKEN: BubbleType[] = ["SPEECH", "NARRATION", "CAPTION"];

/**
 * A bubble that keeps its page from being approved (decisions row 228): a
 * spoken type, read aloud (not ignored, not silent), and no speaker at all.
 * A speaker string outside the cast still counts as a speaker here; the
 * casting gate deals with those. The editor and the approval action both ask
 * this, so the rule has one home.
 */
export function needsSpeaker(b: {
  type: string;
  speaker: string | null;
  silent: boolean;
  ignored: boolean;
}): boolean {
  return (
    (SPOKEN as string[]).includes(b.type) &&
    !b.silent &&
    !b.ignored &&
    !b.speaker?.trim()
  );
}

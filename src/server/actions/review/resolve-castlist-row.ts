import { renderVoice, type BookCast } from "~/lib/cast";

export type ResolveSpeakerVoiceResult =
  | { ok: true; voiceId: string }
  | { ok: false; error: string };

/**
 * A bubble's voice for the review editor, through the audio step's own
 * render chain (`renderVoice` in `~/lib/cast`), keyed on
 * `bubbles.character_id`. Every miss is an error the owner reads, naming its
 * case.
 */
export function resolveSpeakerVoice(
  book: BookCast,
  issueId: string,
  bubble: { speaker: string | null; character_id: string | null },
): ResolveSpeakerVoiceResult {
  const found = renderVoice(book, bubble.character_id, issueId);
  if (found.ok) return { ok: true, voiceId: found.elevenLabsId };
  const who = `speaker '${bubble.speaker ?? "(none)"}'${bubble.character_id ? ` (${bubble.character_id})` : ""}`;
  switch (found.reason) {
    case "unassigned":
      return {
        ok: false,
        error: `${who} has no character, so it gets no audio. Pick the speaker first.`,
      };
    case "removed":
      return {
        ok: false,
        error: `${who} is removed from this issue's cast, so it gets no audio`,
      };
    case "no audio":
      return {
        ok: false,
        error: `${who} is marked no audio in the castlist, so it gets no audio`,
      };
    case "not in a slot":
      return {
        ok: false,
        error: `${who} is cast, and the voice is not in a slot: ${found.detail}`,
      };
    case "no voice":
      return { ok: false, error: `No voice for ${who}: ${found.detail}` };
  }
}

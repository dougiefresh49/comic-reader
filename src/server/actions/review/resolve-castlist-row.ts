import {
  lookupVoice,
  type VoiceLookupContext,
} from "~/workflows/steps/audio-plan";

export type ResolveSpeakerVoiceResult =
  | { ok: true; voiceId: string }
  | { ok: false; error: string };

/**
 * A bubble's voice for the review editor, through the audio step's own
 * lookup (`lookupVoice` in audio-plan.ts): `bubbles.character_id`, then the
 * castlist rows' `character_id`, then the name rule, with the voice from
 * `voiceFor`. Every miss is an error the owner reads, naming its case.
 */
export function resolveSpeakerVoice(
  ctx: VoiceLookupContext,
  bubble: { speaker: string | null; character_id: string | null },
): ResolveSpeakerVoiceResult {
  const found = lookupVoice(ctx, bubble);
  if (found.ok) return { ok: true, voiceId: found.voiceId };
  const who = `speaker '${bubble.speaker ?? "(none)"}'${bubble.character_id ? ` (${bubble.character_id})` : ""}`;
  switch (found.reason) {
    case "castlist conflict":
      return {
        ok: false,
        error: `Ambiguous castlist match for ${who}: ${found.detail}`,
      };
    case "skip sentinel":
      return {
        ok: false,
        error: `${who} is marked no audio in the castlist, so it gets no audio`,
      };
    case "cast without a voice":
      return { ok: false, error: `No voice for ${who}: ${found.detail}` };
    case "no speaker":
      return { ok: false, error: "No speaker assigned" };
    default:
      return {
        ok: false,
        error: `No castlist row matched ${who} after alias lookup`,
      };
  }
}

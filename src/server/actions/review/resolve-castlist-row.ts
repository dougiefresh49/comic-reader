import { SKIPPED_VOICE } from "~/lib/voice-settings";
import {
  buildAliasMap,
  buildCastIndex,
  formatCastConflicts,
  slugify,
  speakerKey,
  type AliasRow,
  type CastRow,
} from "~/workflows/steps/audio-plan";

export type ResolveSpeakerVoiceResult =
  | { ok: true; voiceId: string | null }
  | { ok: false; error: string };

/**
 * Resolve a bubble speaker to its castlist voice with the audio step's rule
 * (audio-plan.ts): an exact castlist.character match picks its own slug
 * group, otherwise the speaker goes through the aliases table and then the
 * slug. A slug group whose rows differ in voice_id is an error naming every
 * row. voiceId is null when the matched group has no voice yet. A group
 * whose voice is the skip marker is an error, as the audio step skips it.
 */
export function resolveSpeakerVoice(
  speaker: string,
  castRows: CastRow[],
  aliasRows: AliasRow[],
): ResolveSpeakerVoiceResult {
  const raw = speaker.trim();
  const cast = buildCastIndex(castRows);
  const exact = castRows.some((row) => row.character === raw);
  const key = exact ? slugify(raw) : speakerKey(raw, buildAliasMap(aliasRows));

  const conflict = cast.conflicts.find((c) => c.slug === key);
  if (conflict) {
    return {
      ok: false,
      error: `Ambiguous castlist match for speaker '${speaker}': ${formatCastConflicts([conflict])}`,
    };
  }
  if (!cast.members.has(key)) {
    return {
      ok: false,
      error: `No castlist row matched speaker '${speaker}' after alias lookup`,
    };
  }
  const voiceId = cast.voices.get(key) ?? null;
  if (voiceId === SKIPPED_VOICE) {
    return {
      ok: false,
      error: `Speaker '${speaker}' is marked skipped in the castlist, so it gets no audio`,
    };
  }
  return { ok: true, voiceId };
}

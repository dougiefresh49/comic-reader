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
 * row. voiceId is null when the matched group has no voice yet.
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
  return { ok: true, voiceId: cast.voices.get(key) ?? null };
}

/**
 * Pure planning helpers for audio generation.
 * Used by generation steps and scripts/plan-audio.ts (SELECT-only).
 * Copied slug/alias rules live here so scripts do not import "use step" modules.
 */

export interface AliasRow {
  alias: string;
  canonical: string;
}

export interface CastRow {
  character: string;
  voice_id: string | null;
}

export interface AppearanceRow {
  id: string;
  character_id: string;
  voice_id: string | null;
  voice_status: string | null;
  voice_description: string | null;
  voice_created_at: string | null;
}

export interface BubbleAudioRow {
  id: string;
  speaker: string | null;
  ignored: boolean;
  audio_storage_path: string | null;
  text_with_cues: string | null;
  ocr_text: string | null;
}

export interface AlignmentRaw {
  characters?: string[];
  character_start_times_seconds?: number[];
  character_end_times_seconds?: number[];
  characterStartTimesSeconds?: number[];
  characterEndTimesSeconds?: number[];
}

export interface NormalizedAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

/** Copied from scripts/utils/registry.ts slugify. Do not import that module. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

export function buildAliasMap(rows: AliasRow[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of rows) {
    map.set(r.alias.toLowerCase().trim(), r.canonical);
  }
  return map;
}

export function resolveAlias(
  raw: string,
  aliasMap: Map<string, string>,
): string {
  const key = raw.toLowerCase().trim();
  return aliasMap.get(key) ?? raw;
}

/** Speaker key = slug(alias-resolved name). */
export function speakerKey(raw: string, aliasMap: Map<string, string>): string {
  return slugify(resolveAlias(raw, aliasMap));
}

/** Castlist keyed by slug(character). First non-empty voice_id wins. */
export function buildCastVoiceMap(rows: CastRow[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of rows) {
    const key = slugify(r.character);
    if (!key || map.has(key)) continue;
    if (r.voice_id) map.set(key, r.voice_id);
  }
  return map;
}

export function isNarratorKey(key: string): boolean {
  return key === "narrator";
}

export function voiceDesignAppearanceId(characterId: string): string {
  return `${characterId}-voice-design`;
}

/**
 * Among ready appearances for a character (voice_status ready, non-empty
 * voice_id), pick the newest voice_created_at.
 */
export function pickReadyAppearanceVoice(
  appearances: AppearanceRow[],
  characterId: string,
): string | null {
  const ready = appearances.filter(
    (a) =>
      a.character_id === characterId &&
      a.voice_status === "ready" &&
      !!a.voice_id,
  );
  if (ready.length === 0) return null;
  ready.sort((a, b) => {
    const aAt = a.voice_created_at ?? "";
    const bAt = b.voice_created_at ?? "";
    return bAt.localeCompare(aAt);
  });
  return ready[0]!.voice_id;
}

export function hasVoiceDesignDescription(
  appearances: AppearanceRow[],
  characterId: string,
): boolean {
  const id = voiceDesignAppearanceId(characterId);
  const row = appearances.find((a) => a.id === id);
  return !!row?.voice_description?.trim();
}

export function getVoiceDesignAppearance(
  appearances: AppearanceRow[],
  characterId: string,
): AppearanceRow | undefined {
  return appearances.find((a) => a.id === voiceDesignAppearanceId(characterId));
}

/** Bubble needs audio when path null, not ignored, and has text. */
export function bubbleNeedsAudio(b: BubbleAudioRow): boolean {
  if (b.ignored) return false;
  if (b.audio_storage_path) return false;
  const text = b.text_with_cues ?? b.ocr_text;
  return !!text?.trim();
}

export function selectBubblesNeedingAudio(
  bubbles: BubbleAudioRow[],
): BubbleAudioRow[] {
  return bubbles.filter(bubbleNeedsAudio);
}

export function normalizeAlignment(
  raw: AlignmentRaw | null | undefined,
): NormalizedAlignment | null {
  if (!raw) return null;
  return {
    characters: raw.characters ?? [],
    character_start_times_seconds:
      raw.character_start_times_seconds ?? raw.characterStartTimesSeconds ?? [],
    character_end_times_seconds:
      raw.character_end_times_seconds ?? raw.characterEndTimesSeconds ?? [],
  };
}

export interface SpeakerMatchPlan {
  distinctSpeakers: string[];
  matched: string[];
  unmatched: string[];
}

/**
 * Distinct raw speaker strings. A raw string is matched when
 * slug(alias-resolved name) has a castlist voice.
 */
export function planSpeakerMatching(
  rawSpeakers: string[],
  aliasMap: Map<string, string>,
  castVoiceMap: Map<string, string>,
): SpeakerMatchPlan {
  const distinct = new Set<string>();
  for (const raw of rawSpeakers) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    distinct.add(trimmed);
  }
  const distinctSpeakers = [...distinct].sort();
  const matched: string[] = [];
  const unmatched: string[] = [];
  for (const raw of distinctSpeakers) {
    const key = speakerKey(raw, aliasMap);
    if (castVoiceMap.has(key)) matched.push(raw);
    else unmatched.push(raw);
  }
  return { distinctSpeakers, matched, unmatched };
}

export interface CharactersNeedingVoicesPlan {
  /** Castlist rows to upsert from a ready appearance (no ElevenLabs). */
  reuse: { character: string; voice_id: string }[];
  /** Character ids that need Voice Design (have `<id>-voice-design` description). */
  needDesign: string[];
}

/**
 * Issue speakers with no castlist row, narrator excluded.
 * Ready appearance voices become reuse upserts; the rest need a voice-design description.
 */
export function planCharactersNeedingVoices(
  rawSpeakers: string[],
  aliasMap: Map<string, string>,
  castVoiceMap: Map<string, string>,
  appearances: AppearanceRow[],
): CharactersNeedingVoicesPlan {
  const keys = new Set<string>();
  for (const raw of rawSpeakers) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    keys.add(speakerKey(trimmed, aliasMap));
  }

  const reuse: { character: string; voice_id: string }[] = [];
  const needDesign: string[] = [];

  for (const key of [...keys].sort()) {
    if (isNarratorKey(key)) continue;
    if (castVoiceMap.has(key)) continue;

    const readyVoice = pickReadyAppearanceVoice(appearances, key);
    if (readyVoice) {
      reuse.push({ character: key, voice_id: readyVoice });
      continue;
    }
    if (hasVoiceDesignDescription(appearances, key)) {
      needDesign.push(key);
    }
  }

  return { reuse, needDesign };
}

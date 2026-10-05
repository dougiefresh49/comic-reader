/**
 * Planning helpers for audio generation. Which voice a bubble speaks with is
 * `renderVoice` in `~/lib/cast` (#429): `planBubbleVoices` applies it to the
 * bubbles the audio step would send. Kept free of "use step" so scripts can
 * import it.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { renderVoice, type BookCast, type RenderVoice } from "~/lib/cast";
import type { Database } from "~/types/database";

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
  silent: boolean;
  audio_storage_path: string | null;
  text_with_cues: string | null;
  ocr_text: string | null;
  emotion?: string | null;
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

export type BubbleSkipReason =
  | "ignored"
  | "silent"
  | "has audio"
  | "no text"
  | Extract<RenderVoice, { ok: false }>["reason"];

export interface SkippedBubble {
  bubble: BubbleAudioRow;
  reason: BubbleSkipReason;
}

/**
 * The character_appearances rows planCharactersNeedingVoices can look up for
 * these speaker keys: rows whose character_id is a key (ready voices), and
 * rows whose id is `<key>-voice-design` (descriptions). The second read is
 * needed because some voice-design rows carry another character_id.
 * Unfiltered, the read stops silently at Supabase's 1,000-row cap. An issue
 * has a few dozen speakers, so each id list stays far below URL limits.
 * Throws on a read error.
 */
export async function readPlanningAppearances(
  client: SupabaseClient<Database>,
  speakerIds: Iterable<string>,
): Promise<AppearanceRow[]> {
  const ids = [...new Set(speakerIds)];
  if (ids.length === 0) return [];
  const columns =
    "id, character_id, voice_id, voice_status, voice_description, voice_created_at";
  const [byCharacter, byDesignId] = await Promise.all([
    client
      .from("character_appearances")
      .select(columns)
      .in("character_id", ids),
    client
      .from("character_appearances")
      .select(columns)
      .in("id", ids.map(voiceDesignAppearanceId)),
  ]);
  if (byCharacter.error) throw new Error(byCharacter.error.message);
  if (byDesignId.error) throw new Error(byDesignId.error.message);

  const rows = new Map<string, AppearanceRow>();
  for (const row of [...(byCharacter.data ?? []), ...(byDesignId.data ?? [])]) {
    rows.set(row.id, row);
  }
  return [...rows.values()];
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
  if (b.ignored || b.silent) return false;
  if (b.audio_storage_path) return false;
  const text = b.text_with_cues ?? b.ocr_text;
  return !!text?.trim();
}

export function selectBubblesNeedingAudio(
  bubbles: BubbleAudioRow[],
): BubbleAudioRow[] {
  return bubbles.filter(bubbleNeedsAudio);
}

/** The bubbles the audio step sends, each with its voice from `renderVoice`, plus skips with reasons. */
export function planBubbleVoices(
  bubbles: (BubbleAudioRow & { character_id: string | null })[],
  book: BookCast,
  issueId: string,
): {
  toSend: { bubble: BubbleAudioRow; lookup: RenderVoice & { ok: true } }[];
  skipped: (SkippedBubble & { lookup?: RenderVoice })[];
} {
  const toSend: {
    bubble: BubbleAudioRow;
    lookup: RenderVoice & { ok: true };
  }[] = [];
  const skipped: (SkippedBubble & { lookup?: RenderVoice })[] = [];
  for (const bubble of bubbles) {
    if (bubble.ignored || bubble.silent) {
      skipped.push({ bubble, reason: bubble.silent ? "silent" : "ignored" });
    } else if (bubble.audio_storage_path) {
      skipped.push({ bubble, reason: "has audio" });
    } else if (!(bubble.text_with_cues ?? bubble.ocr_text)?.trim()) {
      skipped.push({ bubble, reason: "no text" });
    } else {
      const lookup = renderVoice(book, bubble.character_id, issueId);
      if (lookup.ok) toSend.push({ bubble, lookup });
      else skipped.push({ bubble, reason: lookup.reason, lookup });
    }
  }
  return { toSend, skipped };
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

export interface CharactersNeedingVoicesPlan {
  /** Castlist rows to write from a ready appearance (no ElevenLabs). */
  reuse: { characterId: string; elevenLabsId: string }[];
  /** Character ids that need Voice Design (have `<id>-voice-design` description). */
  needDesign: string[];
}

/**
 * The issue's speakers (`bubbles.character_id`) with no castlist row in the
 * issue, narrator excluded. Any castlist row, with a voice or not, blocks
 * reuse and Voice Design. Ready appearance voices become reuse writes; the
 * rest need a voice-design description.
 */
export function planCharactersNeedingVoices(
  characterIds: Iterable<string>,
  castMembers: ReadonlySet<string>,
  appearances: AppearanceRow[],
): CharactersNeedingVoicesPlan {
  const reuse: { characterId: string; elevenLabsId: string }[] = [];
  const needDesign: string[] = [];
  for (const id of [...new Set(characterIds)].sort()) {
    if (isNarratorKey(id) || castMembers.has(id)) continue;
    const ready = pickReadyAppearanceVoice(appearances, id);
    if (ready) reuse.push({ characterId: id, elevenLabsId: ready });
    else if (hasVoiceDesignDescription(appearances, id)) needDesign.push(id);
  }
  return { reuse, needDesign };
}

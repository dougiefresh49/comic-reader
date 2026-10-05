/**
 * Planning helpers for audio generation. Which voice a bubble speaks with is
 * `renderVoice` in `~/lib/cast` (#429): `planBubbleVoices` applies it to the
 * bubbles the audio step would send. Kept free of "use step" so scripts can
 * import it.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { renderVoice, type BookCast, type RenderVoice } from "~/lib/cast";
import {
  designDescriptions,
  readCharacterVoices,
  type CharacterVoice,
} from "~/lib/voice-slots/lookup";

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
 * The `voices` rows planCharactersNeedingVoices looks up for these speaker
 * keys (#458): every voice filed under one of them, active ones and stored
 * design descriptions included. Throws on a read error.
 */
export async function readPlanningVoices(
  client: SupabaseClient,
  speakerIds: Iterable<string>,
): Promise<CharacterVoice[]> {
  return readCharacterVoices(client, speakerIds);
}

export function isNarratorKey(key: string): boolean {
  return key === "narrator";
}

/** The character's newest active voice with an ElevenLabs id, as its `voices.id`. */
export function pickActiveVoice(
  voices: CharacterVoice[],
  characterId: string,
): string | null {
  const ready = voices
    .filter(
      (v) =>
        v.character_id === characterId &&
        v.status === "active" &&
        !!v.current_elevenlabs_id,
    )
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return ready[0]?.id ?? null;
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
  /** Castlist rows to write from the character's active voice (no ElevenLabs). */
  reuse: { characterId: string; voiceUuid: string }[];
  /** Character ids that need Voice Design (a description is stored for them). */
  needDesign: string[];
}

/**
 * The issue's speakers (`bubbles.character_id`) with no castlist row in the
 * issue, narrator excluded. Any castlist row, with a voice or not, blocks
 * reuse and Voice Design. An active voice becomes a reuse write; the rest
 * need a stored design description.
 */
export function planCharactersNeedingVoices(
  characterIds: Iterable<string>,
  castMembers: ReadonlySet<string>,
  voices: CharacterVoice[],
): CharactersNeedingVoicesPlan {
  const reuse: { characterId: string; voiceUuid: string }[] = [];
  const needDesign: string[] = [];
  const described = designDescriptions(voices);
  for (const id of [...new Set(characterIds)].sort()) {
    if (isNarratorKey(id) || castMembers.has(id)) continue;
    const ready = pickActiveVoice(voices, id);
    if (ready) reuse.push({ characterId: id, voiceUuid: ready });
    else if (described.has(id)) needDesign.push(id);
  }
  return { reuse, needDesign };
}

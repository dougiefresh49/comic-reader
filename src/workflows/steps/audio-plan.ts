/**
 * Planning helpers for audio generation, plus the one SELECT they plan from.
 * Used by generation steps and scripts/plan-audio.ts (SELECT-only).
 * Copied slug/alias rules live here so scripts do not import "use step" modules.
 * `lookupVoice` is the one voice lookup the audio step, the review editor's
 * regenerate and `scripts/render-bubble.ts` share (#352).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { voiceFor, type BookCast } from "~/lib/cast";
import { slugify } from "~/lib/character-id";
import { SKIPPED_VOICE } from "~/lib/voice-settings";
import type { Database } from "~/types/database";

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

export interface CastConflict {
  slug: string;
  rows: CastRow[];
}

/**
 * Castlist membership and usable voices, grouped by slug(character).
 * A null voice_id still counts as membership. The skip sentinel is a
 * voice_id value for conflict comparison.
 */
export interface CastIndex {
  /** Slugs with any castlist row for the issue. */
  members: Set<string>;
  /** Usable voice_id per slug (non-null, conflict-free groups only). */
  voices: Map<string, string>;
  conflicts: CastConflict[];
}

export type BubbleSkipReason =
  | "ignored"
  | "silent"
  | "has audio"
  | "no text"
  | "no speaker"
  | "unmatched speaker"
  | "cast without a voice"
  | "skip sentinel"
  | "castlist conflict";

export interface SkippedBubble {
  bubble: BubbleAudioRow;
  reason: BubbleSkipReason;
}

export interface BubbleSendPlan {
  toSend: { bubble: BubbleAudioRow; voiceId: string }[];
  skipped: SkippedBubble[];
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

/** Distinct speaker keys for non-blank raw speaker strings. */
export function speakerKeys(
  rawSpeakers: string[],
  aliasMap: Map<string, string>,
): Set<string> {
  const keys = new Set<string>();
  for (const raw of rawSpeakers) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    keys.add(speakerKey(trimmed, aliasMap));
  }
  return keys;
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

/**
 * Group castlist rows by slug. Membership is separate from usable voices.
 * Rows in a slug group with different voice_id values (null and the skip
 * sentinel included) are conflicts.
 */
export function buildCastIndex(rows: CastRow[]): CastIndex {
  const bySlug = new Map<string, CastRow[]>();
  for (const r of rows) {
    const key = slugify(r.character);
    if (!key) continue;
    const list = bySlug.get(key) ?? [];
    list.push(r);
    bySlug.set(key, list);
  }

  const members = new Set<string>();
  const voices = new Map<string, string>();
  const conflicts: CastConflict[] = [];

  for (const [slug, group] of bySlug) {
    members.add(slug);
    const distinctVoiceIds = new Set(group.map((r) => r.voice_id));
    if (distinctVoiceIds.size > 1) {
      conflicts.push({ slug, rows: group });
      continue;
    }
    const voiceId = group[0]!.voice_id;
    if (voiceId != null) voices.set(slug, voiceId);
  }

  return { members, voices, conflicts };
}

/** Format castlist conflicts for logs and FatalError messages. */
export function formatCastConflicts(conflicts: CastConflict[]): string {
  return conflicts
    .map((c) => {
      const parts = c.rows.map((r) => `${r.character}=${r.voice_id ?? "null"}`);
      return `${c.slug}: ${parts.join(", ")}`;
    })
    .join("; ");
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

/**
 * Bubbles the audio step would send, plus skips with reasons.
 * Castlist conflicts are checked separately before any ElevenLabs call.
 */
export function planBubblesToSend(
  bubbles: BubbleAudioRow[],
  aliasMap: Map<string, string>,
  cast: CastIndex,
): BubbleSendPlan {
  const toSend: { bubble: BubbleAudioRow; voiceId: string }[] = [];
  const skipped: SkippedBubble[] = [];

  for (const bubble of bubbles) {
    if (bubble.ignored || bubble.silent) {
      skipped.push({ bubble, reason: bubble.silent ? "silent" : "ignored" });
      continue;
    }
    if (bubble.audio_storage_path) {
      skipped.push({ bubble, reason: "has audio" });
      continue;
    }
    const text = bubble.text_with_cues ?? bubble.ocr_text;
    if (!text?.trim()) {
      skipped.push({ bubble, reason: "no text" });
      continue;
    }

    const rawSpeaker = bubble.speaker?.trim() ?? "";
    if (!rawSpeaker) {
      skipped.push({ bubble, reason: "no speaker" });
      continue;
    }

    const named = nameVoice(speakerKey(rawSpeaker, aliasMap), cast);
    if (named.ok) toSend.push({ bubble, voiceId: named.voiceId });
    else skipped.push({ bubble, reason: named.reason });
  }

  return { toSend, skipped };
}

/** Today's name rule on a slug key: membership, then a usable voice, then the skip sentinel. */
function nameVoice(
  key: string,
  cast: CastIndex,
):
  | { ok: true; voiceId: string }
  | {
      ok: false;
      reason: "unmatched speaker" | "cast without a voice" | "skip sentinel";
    } {
  if (!cast.members.has(key)) return { ok: false, reason: "unmatched speaker" };
  const voiceId = cast.voices.get(key);
  if (voiceId == null) return { ok: false, reason: "cast without a voice" };
  if (voiceId === SKIPPED_VOICE) return { ok: false, reason: "skip sentinel" };
  return { ok: true, voiceId };
}

/** Where `lookupVoice` found the character, in its lookup order. */
export type VoiceSource =
  | "bubble character_id"
  | "castlist character_id"
  | "name";

/** What `lookupVoice` reads: the book's cast, the issue, the scoped aliases, and the issue's castlist grouped by slug. */
export interface VoiceLookupContext {
  book: BookCast;
  issueId: string;
  aliasMap: Map<string, string>;
  cast: CastIndex;
}

export function voiceLookupContext(
  book: BookCast,
  issueId: string,
  aliasRows: AliasRow[],
): VoiceLookupContext {
  return {
    book,
    issueId,
    aliasMap: buildAliasMap(aliasRows),
    cast: buildCastIndex(book.rows.filter((r) => r.issue_id === issueId)),
  };
}

export type VoiceLookup =
  | {
      ok: true;
      voiceId: string;
      source: VoiceSource;
      /** The character the voice is for; null on the name path. */
      characterId: string | null;
      /** The character whose castlist row holds the voice: itself, or its `voice_of`. Null on the name path. */
      from: string | null;
    }
  | {
      ok: false;
      reason:
        | "no speaker"
        | "unmatched speaker"
        | "cast without a voice"
        | "skip sentinel"
        | "castlist conflict";
      source: VoiceSource | null;
      characterId: string | null;
      /** One line naming the case, for logs and error messages. */
      detail: string;
    };

/** One issue's castlist rows for a character: by `character_id`, else the null-id rows whose text resolves to it (how `voiceFor` matches). */
function issueRowsFor(
  ctx: VoiceLookupContext,
  characterId: string,
  issueId = ctx.issueId,
) {
  const here = ctx.book.rows.filter((r) => r.issue_id === issueId);
  const byId = here.filter((r) => r.character_id === characterId);
  if (byId.length > 0) return byId;
  return here.filter(
    (r) =>
      r.character_id === null &&
      (ctx.book.resolve(r.character)?.id ?? slugify(r.character)) ===
        characterId,
  );
}

/**
 * The rows `voiceFor` takes a character's own voice from: this issue's rows
 * when one is voiced, else the latest issue's with a voiced row.
 */
function supplyingRows(ctx: VoiceLookupContext, characterId: string) {
  const voiced = (r: { voice_id: string | null; voice_uuid: string | null }) =>
    r.voice_id !== SKIPPED_VOICE &&
    (r.voice_id !== null || r.voice_uuid !== null);
  const issues = [...new Set(ctx.book.rows.map((r) => r.issue_id))]
    .map((issueId) => ({
      issueId,
      rows: issueRowsFor(ctx, characterId, issueId),
    }))
    .filter((x) => x.rows.some(voiced));
  const latest = (i: string) => ctx.book.issueNumber.get(i) ?? 0;
  return (
    issues.find((x) => x.issueId === ctx.issueId) ??
    issues.sort((a, b) => latest(b.issueId) - latest(a.issueId))[0]
  );
}

/** A conflict detail when the rows disagree on `voice_id`, else null. */
function rowConflict(
  label: string,
  rows: { character: string; voice_id: string | null }[],
): string | null {
  if (new Set(rows.map((r) => r.voice_id)).size <= 1) return null;
  return `castlist rows for ${label} disagree on voice_id: ${rows.map((r) => `${r.character}=${r.voice_id ?? "null"}`).join(", ")}`;
}

/**
 * A bubble's voice, in one order (#352): `bubbles.character_id`, then the
 * `character_id` on the issue's castlist rows its speaker names (by slug
 * group, or the speaker is that id), then today's name
 * lookup. Once an id is found it decides: the voice comes from `voiceFor`, so
 * a form with no voice of its own speaks in its `voice_of` character's voice,
 * and a miss there stays a miss rather than falling through to a name match.
 *
 * Refuses (`castlist conflict`) when the speaker's slug group, or the found
 * character's rows in this issue, disagree on `voice_id`. A character whose
 * row in this issue is the skip sentinel ("no audio this run") is `skip
 * sentinel`, as a skipped castlist row is on the name path.
 */
export function lookupVoice(
  ctx: VoiceLookupContext,
  bubble: { speaker: string | null; character_id: string | null },
): VoiceLookup {
  const raw = bubble.speaker?.trim() ?? "";
  const key = raw ? speakerKey(raw, ctx.aliasMap) : "";
  const fail = (
    reason: Extract<VoiceLookup, { ok: false }>["reason"],
    source: VoiceSource | null,
    characterId: string | null,
    detail: string,
  ): VoiceLookup => ({ ok: false, reason, source, characterId, detail });

  const conflict = ctx.cast.conflicts.find((c) => c.slug === key);
  if (conflict) {
    return fail(
      "castlist conflict",
      null,
      bubble.character_id,
      `castlist rows disagree on voice_id: ${formatCastConflicts([conflict])}`,
    );
  }

  let characterId = bubble.character_id;
  let source: VoiceSource = "bubble character_id";
  if (!characterId && key) {
    source = "castlist character_id";
    const ids = new Set(
      ctx.book.rows.flatMap((r) =>
        r.issue_id === ctx.issueId &&
        r.character_id !== null &&
        (slugify(r.character) === key || r.character_id === key)
          ? [r.character_id]
          : [],
      ),
    );
    if (ids.size > 1) {
      return fail(
        "castlist conflict",
        source,
        null,
        `castlist rows for '${raw}' carry different character_id values: ${[...ids].join(", ")}`,
      );
    }
    characterId = [...ids][0] ?? null;
  }

  if (characterId) {
    const rows = issueRowsFor(ctx, characterId);
    const own = rowConflict(characterId, rows);
    if (own) return fail("castlist conflict", source, characterId, own);
    const voice = voiceFor(ctx.book, characterId, ctx.issueId);
    if (voice) {
      // The rows the voice came from: the donor's for a `voice_of` form, or
      // an earlier issue's when this issue has no voiced row.
      const supplier = supplyingRows(ctx, voice.from);
      const inherited =
        supplier &&
        rowConflict(`${voice.from} in ${supplier.issueId}`, supplier.rows);
      if (inherited) {
        return fail("castlist conflict", source, characterId, inherited);
      }
    }
    if (voice?.voiceId) {
      return {
        ok: true,
        voiceId: voice.voiceId,
        source,
        characterId,
        from: voice.from,
      };
    }
    if (!voice && rows.some((r) => r.voice_id === SKIPPED_VOICE)) {
      return fail(
        "skip sentinel",
        source,
        characterId,
        `${characterId} is marked no audio in this issue`,
      );
    }
    return fail(
      "cast without a voice",
      source,
      characterId,
      `${characterId} has no voice of its own or through voice_of`,
    );
  }

  if (!raw)
    return fail("no speaker", null, null, "no speaker, no character_id");
  const named = nameVoice(key, ctx.cast);
  if (named.ok) {
    return {
      ok: true,
      voiceId: named.voiceId,
      source: "name",
      characterId: null,
      from: null,
    };
  }
  return fail(
    named.reason,
    "name",
    null,
    `speaker '${raw}' (${key}): ${named.reason}`,
  );
}

/** The bubbles the audio step sends, each with its voice from `lookupVoice`, plus skips with reasons. */
export function planBubbleVoices(
  bubbles: (BubbleAudioRow & { character_id: string | null })[],
  ctx: VoiceLookupContext,
): {
  toSend: { bubble: BubbleAudioRow; lookup: VoiceLookup & { ok: true } }[];
  skipped: (SkippedBubble & { lookup?: VoiceLookup })[];
} {
  const toSend: {
    bubble: BubbleAudioRow;
    lookup: VoiceLookup & { ok: true };
  }[] = [];
  const skipped: (SkippedBubble & { lookup?: VoiceLookup })[] = [];
  for (const bubble of bubbles) {
    if (bubble.ignored || bubble.silent) {
      skipped.push({ bubble, reason: bubble.silent ? "silent" : "ignored" });
    } else if (bubble.audio_storage_path) {
      skipped.push({ bubble, reason: "has audio" });
    } else if (!(bubble.text_with_cues ?? bubble.ocr_text)?.trim()) {
      skipped.push({ bubble, reason: "no text" });
    } else {
      const lookup = lookupVoice(ctx, bubble);
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

export interface SpeakerMatchPlan {
  distinctSpeakers: string[];
  /** Speakers whose slug has a usable castlist voice_id (including skip sentinel). */
  matched: string[];
  /** Speakers with no castlist row at all. */
  unmatched: string[];
  /** Speakers with a castlist row but null voice_id. */
  castWithoutVoice: string[];
  /** Speakers whose slug has conflicting castlist voice_id values. */
  conflicted: string[];
}

/**
 * Distinct raw speaker strings. Matched = castlist voice present.
 * Cast membership without a voice is neither matched nor unmatched.
 * Conflicted slugs are their own bucket, not cast without a voice.
 */
export function planSpeakerMatching(
  rawSpeakers: string[],
  aliasMap: Map<string, string>,
  cast: CastIndex,
): SpeakerMatchPlan {
  const distinct = new Set<string>();
  for (const raw of rawSpeakers) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    distinct.add(trimmed);
  }
  const distinctSpeakers = [...distinct].sort();
  const conflictSlugs = new Set(cast.conflicts.map((c) => c.slug));
  const matched: string[] = [];
  const unmatched: string[] = [];
  const castWithoutVoice: string[] = [];
  const conflicted: string[] = [];
  for (const raw of distinctSpeakers) {
    const key = speakerKey(raw, aliasMap);
    if (conflictSlugs.has(key)) conflicted.push(raw);
    else if (cast.voices.has(key)) matched.push(raw);
    else if (cast.members.has(key)) castWithoutVoice.push(raw);
    else unmatched.push(raw);
  }
  return {
    distinctSpeakers,
    matched,
    unmatched,
    castWithoutVoice,
    conflicted,
  };
}

export interface CharactersNeedingVoicesPlan {
  /** Castlist rows to upsert from a ready appearance (no ElevenLabs). */
  reuse: { character: string; voice_id: string }[];
  /** Character ids that need Voice Design (have `<id>-voice-design` description). */
  needDesign: string[];
}

/**
 * Issue speakers with no castlist row, narrator excluded.
 * Any castlist membership (including null voice_id) blocks reuse and Voice Design.
 * Ready appearance voices become reuse upserts; the rest need a voice-design description.
 */
export function planCharactersNeedingVoices(
  rawSpeakers: string[],
  aliasMap: Map<string, string>,
  cast: CastIndex,
  appearances: AppearanceRow[],
): CharactersNeedingVoicesPlan {
  const keys = speakerKeys(rawSpeakers, aliasMap);

  const reuse: { character: string; voice_id: string }[] = [];
  const needDesign: string[] = [];

  for (const key of [...keys].sort()) {
    if (isNarratorKey(key)) continue;
    if (cast.members.has(key)) continue;

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

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Narrow row types, read from `select("*")`. `status` is `needs_clip` for a
 * voice asked for with no clip yet (a voice-lab clone, or a description
 * stored before its design, #458), `archived` for a sample stored in the
 * clips bucket and not in a slot, `active` for one in a slot.
 */
export interface VoiceRow {
  id: string;
  display_name: string;
  status: "active" | "archived" | "needs_clip" | "library";
  /** The character the voice is for; null for a room-only voice. */
  character_id: string | null;
  /** The work it was cloned from; null for a designed voice. */
  appearance_id: string | null;
  /** The owner's default pick for the character on the voice-lab cast sheet. */
  starting_pick: boolean;
  current_elevenlabs_id: string | null;
  /** Object path inside the `comic-voice-clips` bucket. */
  source_clip_path: string | null;
  source_clip_md5: string | null;
  design_prompt: string | null;
  description: string | null;
  labels: Record<string, string> | null;
  consumers: string[];
  keep_active: boolean;
  created_at: string;
  archived_at: string | null;
}

/** A castlist row's voice reference, as `~/lib/cast` reads it. */
export type { CastVoiceLink as CastlistRow } from "~/lib/cast";

/**
 * What every module function takes first. `fetch` and `apiKey` default to
 * the globals; a fake `fetch` drives the refusal script without a network.
 */
export interface VoiceSlotsDeps {
  supabase: SupabaseClient;
  fetch?: typeof globalThis.fetch;
  apiKey?: string;
  /** Per-request ElevenLabs timeout in ms. Default 60000. */
  timeoutMs?: number;
}

/** The issue about to be worked, whose voices archive must leave alone. */
export interface IssueTarget {
  bookId: string;
  issueId: string;
}

export interface SlotStatus {
  voice_slots_used: number;
  voice_limit: number;
  voice_add_edit_counter: number;
  max_voice_add_edits: number;
}

/**
 * The owner's v2 voices (AGENTS.md, "Voice slots"): every `voices` row with
 * `status = 'active'` for one of these characters is never re-cloned,
 * swapped out, archived or deleted, and its ElevenLabs voice is never
 * edited. The voice-lab import skips their rows; the archive guard and the
 * casting moves refuse them.
 */
export const PROTECTED_CHARACTER_IDS: ReadonlySet<string> = new Set([
  "michelangelo",
  "donatello",
  "raphael",
  "master-splinter",
]);

/** True for an active row of a protected character (`PROTECTED_CHARACTER_IDS`). */
export function isProtectedVoice(voice: {
  status: string;
  character_id: string | null;
}): boolean {
  return (
    voice.status === "active" &&
    voice.character_id !== null &&
    PROTECTED_CHARACTER_IDS.has(voice.character_id)
  );
}

export type ArchiveRefusal =
  | "protected"
  | "not active"
  | "room consumer"
  | "keep_active"
  | "excluded"
  | "no snapshot"
  | "bucket copy missing"
  | "md5 mismatch"
  | "no description"
  | "no labels"
  | "needed by issue";

export type RestoreRefusal =
  | "not archived"
  | "no snapshot"
  | "bucket copy missing"
  | "md5 mismatch"
  | "no description"
  | "no labels"
  | "no free slot"
  | "no add/edit headroom";

export interface ArchiveResult {
  voice: VoiceRow;
  ok: boolean;
  refusals: ArchiveRefusal[];
  /** True only after the DELETE and the DB writes ran. */
  executed: boolean;
  /** ElevenLabs already had no such voice; the DB writes still ran. */
  alreadyGone?: boolean;
}

export interface RestoreResult {
  voice: VoiceRow;
  ok: boolean;
  refusals: RestoreRefusal[];
  warnings: string[];
  executed: boolean;
  newElevenLabsId?: string;
}

export interface SnapshotSampleReport {
  sampleId: string;
  fileName: string;
  bytes: number;
  elevenLabsHash: string;
  md5: string;
  match: boolean;
  objectPath: string;
  /** The bucket already holds these bytes under this path. */
  alreadyStored: boolean;
}

export interface SnapshotResult {
  voice: VoiceRow;
  ok: boolean;
  refusals: string[];
  samples: SnapshotSampleReport[];
  executed: boolean;
  /** True after the complete sample manifest was written. */
  manifestWritten?: boolean;
}

/** How a kept clip lines up with the voice's ElevenLabs samples, best first. */
export type SourceClipMatch =
  | "md5 equals the sample hash"
  | "bytes equal the sample size"
  | "no match";

/** What `snapshotFromFile` found and, with `execute`, wrote (#475). */
export interface SnapshotFromFileResult {
  /** The row read fresh; after a write, the row read back. */
  voice: VoiceRow;
  ok: boolean;
  refusals: string[];
  /** Reported, never refusals: a second sample, no sample, no ElevenLabs id. */
  flags: string[];
  samples: { fileName: string; sizeBytes: number; hash: string }[];
  fileName: string;
  bytes: number;
  md5: string;
  match: SourceClipMatch;
  objectPath: string;
  /** The bucket already holds these bytes under this path. */
  alreadyStored: boolean;
  archiveRefusalsBefore: ArchiveRefusal[];
  executed: boolean;
  archiveRefusalsAfter?: ArchiveRefusal[];
  snapshotStatus?: "ok" | "missing" | "mismatch";
}

export interface SnapshotManifestSample {
  fileName: string;
  objectPath: string;
  /** md5 of the bytes stored in the bucket. */
  md5: string;
  /** md5 ElevenLabs reported for the uploaded file, for the record. */
  elevenLabsHash: string;
  bytes: number;
}

/**
 * What a snapshot leaves beside the clips, at
 * `<voices.id>/snapshot.json`. `voices.source_clip_path` holds one path, so
 * a voice with several ElevenLabs samples needs the rest named somewhere
 * hash-checked; restore reads every sample in the manifest.
 */
export interface SnapshotManifest {
  voiceId: string;
  formerElevenLabsId: string;
  samples: SnapshotManifestSample[];
}

export interface FreeSlotsPlan {
  ok: boolean;
  refusals: string[];
  status: SlotStatus;
  freeNow: number;
  toArchive: number;
  /** Eligible voices in policy order, as many as `toArchive` needs. */
  pick: VoiceRow[];
  /** Eligible voices the plan did not need; their bucket copy went unchecked. */
  spare: VoiceRow[];
  refused: { voice: VoiceRow; refusals: ArchiveRefusal[] }[];
  addEditHeadroom: number;
}

export interface CreateVoiceMeta {
  name: string;
  description?: string | null;
  labels?: Record<string, string> | null;
}

export interface CreateVoiceResult {
  executed: boolean;
  /** One line per multipart field, for the dry run. */
  payload: string[];
  voiceId?: string;
  /** The `voices` row id when `register` was set. */
  registeredId?: string;
}

/** The ElevenLabs voice slots this repo shares with the owner's other projects. */
export const VOICE_SLOTS_TOTAL = 30;

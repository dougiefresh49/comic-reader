import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Narrow row types, read from `select("*")`. `src/types/database.ts` predates
 * the #91 registry columns (consumers, description, labels, source_clip_md5,
 * lab_default) and #95 (`characters.voice_of`, `castlist.character_id`); the
 * lead regenerates it after those apply. Until then these carry the shape.
 */
export interface VoiceRow {
  id: string;
  display_name: string;
  status: "active" | "archived" | "library";
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

export interface CastlistRow {
  book_id: string;
  issue_id: string;
  character: string;
  /** #95 adds it, #100 fills it. Null on every row before then. */
  character_id: string | null;
  voice_id: string | null;
  voice_uuid: string | null;
}

export interface CharacterRow {
  id: string;
  /** #95: the character whose voice this form speaks with. */
  voice_of: string | null;
}

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

export type ArchiveRefusal =
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

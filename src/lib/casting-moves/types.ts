/**
 * The casting moves' shapes (#786). A `Move` is what the casting page stages
 * on the client, plain JSON; `confirmMoves` writes one `casting_moves` row
 * per move, so the field names are the row's column names. Every move is
 * about the issue the page is open on.
 */

export type MoveKind =
  | "archive"
  | "restore"
  | "create_design"
  | "cast"
  | "stand_in"
  | "sit_out"
  | "back_in"
  | "add_character"
  | "remove_character"
  | "rename";

/**
 * Frees a voice's slot. A `voices` row by `voice_uuid`; a voice on the
 * account with no row (another project's) by `elevenlabs_id`, which gets a
 * `voices` row at confirm so it can be backed up and come back. `backup`
 * (the "Back up first" tick) snapshots the samples and fills missing labels
 * before the DELETE; `lossy_ok` accepts an archive the voice cannot come
 * back from.
 */
export interface ArchiveMove {
  kind: "archive";
  voice_uuid: string | null;
  elevenlabs_id?: string | null;
  backup: boolean;
  lossy_ok: boolean;
}

/** Brings an archived voice back into a slot; with `character_id`, casts it for that character (this issue and the book's later ones). */
export interface RestoreMove {
  kind: "restore";
  voice_uuid: string;
  character_id: string | null;
  /** The voice the character spoke with before, for the record. */
  replaces_voice_uuid?: string | null;
}

/**
 * Saves an accepted Voice Design take as the character's voice and casts it
 * (`createFromPreview`, one slot). `run_only`: cast in this issue only, and
 * marked `voices.run_only`.
 */
export interface CreateDesignMove {
  kind: "create_design";
  character_id: string;
  generated_voice_id: string;
  design_prompt: string;
  preview_text: string;
  run_only: boolean;
  replaces_voice_uuid?: string | null;
}

/** The character speaks with an existing voice in this issue and the book's later issues. */
export interface CastMove {
  kind: "cast";
  character_id: string;
  voice_uuid: string;
  replaces_voice_uuid?: string | null;
}

/** The character borrows an existing voice for this issue only. */
export interface StandInMove {
  kind: "stand_in";
  character_id: string;
  voice_uuid: string;
  replaces_voice_uuid?: string | null;
}

/** No audio for the character in this issue (`castlist.no_audio`). */
export interface SitOutMove {
  kind: "sit_out";
  character_id: string;
}

/** Clears `castlist.no_audio` for the character in this issue. */
export interface BackInMove {
  kind: "back_in";
  character_id: string;
}

/** Puts a character in this issue's cast: an existing one by id, or a new one by `name` with `character_id` null. */
export interface AddCharacterMove {
  kind: "add_character";
  character_id: string | null;
  name: string;
}

/** "Not in this issue": `castlist.in_issue` false; the row and its voice are kept. */
export interface RemoveCharacterMove {
  kind: "remove_character";
  character_id: string;
}

/** Renames a character (its display name; the id stays). */
export interface RenameMove {
  kind: "rename";
  character_id: string;
  name: string;
}

export type Move =
  | ArchiveMove
  | RestoreMove
  | CreateDesignMove
  | CastMove
  | StandInMove
  | SitOutMove
  | BackInMove
  | AddCharacterMove
  | RemoveCharacterMove
  | RenameMove;

/** The moves that take a slot. */
export type AddMove = RestoreMove | CreateDesignMove;

export type BlockerCode =
  /** An archive the voice cannot come back from, without `lossy_ok`. */
  | "lossy"
  /** A restore or design with no free slot and no archive left to free one. */
  | "no_slot"
  /** A speaking character left with no playable voice and not sitting out. */
  | "unvoiced_speaker"
  /** A move on one of the owner's v2 voices. */
  | "protected"
  /** An archive of a voice with `keep_active`. */
  | "keep_active"
  /** An archive of a voice the room app uses. */
  | "room"
  /** An archive of another project's voice pinned in `account_voice_owners`. */
  | "pinned"
  /** More adds than the month's add/edit headroom. */
  | "headroom"
  /** A restore whose voice cannot come back (no snapshot, bucket copy, description or labels). */
  | "not_restorable"
  /** A move on a voice an earlier run left unresolved; `reconcileRun` settles it first. */
  | "unresolved"
  /** A move that names no such voice or character, or one in the wrong state. */
  | "invalid";

export interface Blocker {
  /** Index into the staged moves; null for a blocker no single move causes. */
  moveIndex: number | null;
  code: BlockerCode;
  /** One line for the owner. */
  reason: string;
}

export type StepKind = MoveKind | "backup";

/** What an archive's backup step does at confirm. */
export interface BackupPlan {
  /** `snapshotSample` runs: the voice has no valid snapshot in the bucket. */
  snapshot: boolean;
  /** Minimal labels are written from the description. */
  labels: boolean;
  /** The voice cannot come back after the archive (blank description, or no backup). */
  lossy: boolean;
}

/** One line of the run, in run order. An archive with `backup` is two steps: its backup, then the archive. */
export interface PlanStep {
  /** Position in run order, from 0. */
  seq: number;
  moveIndex: number;
  kind: StepKind;
  /** One line for the owner, e.g. "Bring back Green Ranger (Tommy) (1993) for Green Ranger". */
  label: string;
  voiceUuid: string | null;
  characterId: string | null;
  /** Slot effect: an add uses a `free` slot or one an archive in this plan `freed`; an archive `frees` one. */
  slot: "free" | "freed" | "frees" | null;
  /** For an add on a freed slot: the archive move that frees it. */
  slotFromMove: number | null;
  backup: BackupPlan | null;
  warnings: string[];
}

export interface MovesPlan {
  bookId: string;
  issueId: string;
  steps: PlanStep[];
  slots: { before: number; after: number; limit: number };
  /**
   * `run`: credits the confirm spends (restores and designs from a kept take
   * spend none). `previews`: credits the design takes already spent, about
   * one per preview-text character.
   */
  credits: { run: number; previews: number };
  /** The month's add/edit count: what is left, and how many adds this plan makes. */
  headroom: { left: number; adds: number };
  blockers: Blocker[];
}

/** Who holds a slot on the ElevenLabs account. */
export type SlotHolder =
  | {
      kind: "repo";
      voiceUuid: string;
      name: string;
      characterId: string | null;
      elevenLabsId: string;
    }
  | {
      kind: "outside";
      elevenLabsId: string;
      name: string;
      /** `account_voice_owners.project_name`, or "Other project". */
      owner: string;
      /** This repo registered a row for it (an archive of it ran here). */
      voiceUuid: string | null;
    }
  | { kind: "free" };

/** Whether the voice in a slot can be moved out, and why not. */
export type SlotLock =
  | "movable"
  | "protected"
  | "pinned"
  | "room"
  | "keep_active"
  | "free";

export interface RosterSlot {
  /** 1 to the account's limit. */
  index: number;
  holder: SlotHolder;
  lock: SlotLock;
  /** Free cheap read of an archive's backup: `ready` (snapshot path on the row), `at confirm` (snapshot or labels made then), `lossy`. Null for a free slot or a locked voice. */
  backup: "ready" | "at confirm" | "lossy" | null;
}

/** A voice on the account that holds no voice slot (a professional voice), listed beside the slots so the roster still totals the limit. */
export interface UnslottedVoice {
  elevenLabsId: string;
  name: string;
  category: string;
  owner: string;
}

export interface Roster {
  limit: number;
  used: number;
  free: number;
  slots: RosterSlot[];
  unslotted: UnslottedVoice[];
  /** Counts that disagree (the account's slot holders against `voice_slots_used`, a repo voice missing from the account). */
  warnings: string[];
}

export type MoveStatus = "pending" | "done" | "failed" | "needs_attention";

export interface MoveOutcome {
  moveIndex: number;
  seq: number;
  kind: MoveKind;
  status: MoveStatus;
  reasons: string[];
  /** The voice the move made or changed. */
  voiceUuid?: string | null;
  elevenLabsId?: string | null;
}

export type RunResult =
  /** The plan has blockers; no row was written and nothing was spent. */
  | { status: "refused"; runId: null; blockers: Blocker[] }
  /**
   * `done`: every move ran. `stopped`: a move failed or needs attention; the
   * moves after it were not run and stay `pending` on their rows.
   */
  | {
      status: "done" | "stopped";
      runId: string;
      plan: MovesPlan;
      moves: MoveOutcome[];
    };

/** Opt-ins for `planMoves`/`runMoves`; the casting page passes none. */
export interface PlanOptions {
  /**
   * The audio step's run_only archive (#790): a speaker this plan's archive
   * leaves with no slot is not unvoiced when every line of theirs here that
   * has text already has audio rendered by that voice (`bubbles.voice_id`).
   */
  renderedLinesVoiced?: boolean;
}

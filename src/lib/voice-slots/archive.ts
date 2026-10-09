import { checkSnapshot } from "./bucket";
import { deleteVoice, metadataRefusals } from "./elevenlabs";
import {
  booksUsingVoice,
  issueNeeds,
  markArchived,
  readCastlist,
} from "./registry";
import {
  isProtectedVoice,
  type ArchiveRefusal,
  type ArchiveResult,
  type IssueTarget,
  type VoiceRow,
  type VoiceSlotsDeps,
} from "./types";

export const ROOM_CONSUMER = "room";

export interface ArchiveGuardOptions {
  /** `voices.id` set the target issue needs; see `issueNeeds`. */
  needs?: Set<string>;
  /** ElevenLabs ids to leave alone (`--exclude-ids`). */
  excludeIds?: Set<string>;
  /**
   * The owner accepted losing the voice (a casting move's `lossy_ok`): the
   * backup refusals (snapshot, bucket copy, description, labels) are
   * skipped. Every other refusal still holds.
   */
  lossyOk?: boolean;
}

/** The refusals that only say the voice could not come back; `lossyOk` waives them. */
const BACKUP_REFUSALS: ReadonlySet<ArchiveRefusal> = new Set([
  "no snapshot",
  "bucket copy missing",
  "md5 mismatch",
  "no description",
  "no labels",
]);

export interface ArchiveOptions extends ArchiveGuardOptions {
  /** The issue about to be worked. Computes `needs` when not given. */
  target?: IssueTarget;
  /** For the `voice_archives` row. Defaults to the voice's first castlist book. */
  archivedForBookId?: string | null;
  execute?: boolean;
}

/** The refusals that need no network. Every one that applies is listed. */
export function archiveRefusalsCheap(
  voice: VoiceRow,
  opts: ArchiveGuardOptions = {},
): ArchiveRefusal[] {
  const refusals: ArchiveRefusal[] = [];
  if (isProtectedVoice(voice)) refusals.push("protected");
  if (voice.status !== "active" || !voice.current_elevenlabs_id)
    refusals.push("not active");
  if (voice.consumers.includes(ROOM_CONSUMER)) refusals.push("room consumer");
  if (voice.keep_active) refusals.push("keep_active");
  if (
    voice.current_elevenlabs_id &&
    opts.excludeIds?.has(voice.current_elevenlabs_id)
  )
    refusals.push("excluded");
  if (!voice.source_clip_path || !voice.source_clip_md5)
    refusals.push("no snapshot");
  refusals.push(...metadataRefusals(voice));
  if (opts.needs?.has(voice.id)) refusals.push("needed by issue");
  return opts.lossyOk
    ? refusals.filter((r) => !BACKUP_REFUSALS.has(r))
    : refusals;
}

/**
 * All refusals for one voice. The bucket copy is downloaded and hashed only
 * when the cheap checks pass, so a plan over thirty voices costs a download
 * per real candidate, not per row.
 */
export async function archiveRefusals(
  deps: VoiceSlotsDeps,
  voice: VoiceRow,
  opts: ArchiveGuardOptions = {},
): Promise<ArchiveRefusal[]> {
  const cheap = archiveRefusalsCheap(voice, opts);
  if (cheap.length > 0 || opts.lossyOk) return cheap;
  const stored = await checkSnapshot(deps.supabase, voice);
  if (stored.status === "missing") return ["bucket copy missing"];
  if (stored.status === "mismatch") return ["md5 mismatch"];
  return [];
}

/**
 * Frees the voice's slot: refuses unless every guard passes (decisions rows
 * 23 and 25), then DELETEs on ElevenLabs and writes #66's rows. Without
 * `execute` it only reports. A 404 from the DELETE counts as done.
 */
export async function archiveVoice(
  deps: VoiceSlotsDeps,
  voice: VoiceRow,
  opts: ArchiveOptions = {},
): Promise<ArchiveResult> {
  const needs =
    opts.needs ??
    (opts.target ? await issueNeeds(deps.supabase, opts.target) : undefined);
  const refusals = await archiveRefusals(deps, voice, {
    needs,
    excludeIds: opts.excludeIds,
    lossyOk: opts.lossyOk,
  });
  const ok = refusals.length === 0;
  if (!ok || !opts.execute) return { voice, ok, refusals, executed: false };

  const elId = voice.current_elevenlabs_id!;
  const { alreadyGone } = await deleteVoice(deps, elId);
  try {
    const forBook =
      opts.archivedForBookId === undefined
        ? (booksUsingVoice(voice.id, await readCastlist(deps.supabase))[0] ??
          null)
        : opts.archivedForBookId;
    await markArchived(deps.supabase, voice, elId, forBook);
  } catch (err) {
    throw new ArchiveRecordError(voice, elId, err);
  }
  return { voice, ok: true, refusals: [], executed: true, alreadyGone };
}

/**
 * The DELETE was confirmed but a registry write after it failed. The slot is
 * free; `restoreVoice` takes the voice back with `deleteConfirmed`, or from
 * the `voice_archives` row when that write landed.
 */
export class ArchiveRecordError extends Error {
  constructor(
    public readonly voice: VoiceRow,
    public readonly formerElevenLabsId: string,
    cause: unknown,
  ) {
    super(
      `DELETE of ${voice.display_name} (${formerElevenLabsId}) landed, but recording it failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "ArchiveRecordError";
  }
}

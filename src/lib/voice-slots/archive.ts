import { checkSnapshot } from "./bucket";
import { deleteVoice } from "./elevenlabs";
import {
  booksUsingVoice,
  issueNeeds,
  markArchived,
  readCastlist,
} from "./registry";
import type {
  ArchiveRefusal,
  ArchiveResult,
  IssueTarget,
  VoiceRow,
  VoiceSlotsDeps,
} from "./types";

export const ROOM_CONSUMER = "room";

export interface ArchiveGuardOptions {
  /** `voices.id` set the target issue needs; see `issueNeeds`. */
  needs?: Set<string>;
  /** ElevenLabs ids to leave alone (`--exclude-ids`). */
  excludeIds?: Set<string>;
}

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
  if (opts.needs?.has(voice.id)) refusals.push("needed by issue");
  return refusals;
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
  if (cheap.length > 0) return cheap;
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
  });
  const ok = refusals.length === 0;
  if (!ok || !opts.execute) return { voice, ok, refusals, executed: false };

  const elId = voice.current_elevenlabs_id!;
  const { alreadyGone } = await deleteVoice(deps, elId);
  const forBook =
    opts.archivedForBookId === undefined
      ? (booksUsingVoice(voice.id, await readCastlist(deps.supabase))[0] ??
        null)
      : opts.archivedForBookId;
  await markArchived(deps.supabase, voice, elId, forBook);
  return { voice, ok: true, refusals: [], executed: true, alreadyGone };
}

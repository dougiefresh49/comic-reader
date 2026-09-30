import { archiveRefusals, archiveRefusalsCheap } from "./archive";
import { getSlotStatus } from "./elevenlabs";
import {
  booksUsingVoice,
  issueNeeds,
  lastUsedByVoice,
  readCastlist,
  readVoices,
} from "./registry";
import type {
  ArchiveRefusal,
  CastlistRow,
  FreeSlotsPlan,
  IssueTarget,
  VoiceRow,
  VoiceSlotsDeps,
} from "./types";

export interface PlanFreeSlotsOptions extends IssueTarget {
  excludeIds?: Set<string>;
}

/**
 * Policy order for archive candidates. Tier 0: a parked book's generated
 * voices, meaning every book that casts the voice is not the target and the
 * voice has a `design_prompt` (it comes back as a cloned IVC from its
 * preview sample at the same slot cost, decision 2). Then least recently
 * used, never-cast voices first; `display_name` breaks ties.
 */
export function orderCandidates(
  voices: VoiceRow[],
  castlist: CastlistRow[],
  lastUsed: Map<string, string | null>,
  targetBookId: string,
): VoiceRow[] {
  const tier = (v: VoiceRow): number => {
    const books = booksUsingVoice(v.id, castlist);
    const parked = books.length > 0 && books.every((b) => b !== targetBookId);
    return parked && v.design_prompt ? 0 : 1;
  };
  return [...voices].sort((a, b) => {
    const t = tier(a) - tier(b);
    if (t !== 0) return t;
    const la = lastUsed.get(a.id) ?? "";
    const lb = lastUsed.get(b.id) ?? "";
    if (la !== lb) return la < lb ? -1 : 1;
    return a.display_name.localeCompare(b.display_name);
  });
}

/**
 * Which voices to archive so `n` adds fit, for the issue in `opts`. Reads
 * only: `slotStatus` and SELECTs, plus a bucket download per voice it
 * picks. Refuses when the eligible set is short, or when the add/edit
 * counter leaves less headroom than `n`.
 */
export async function planFreeSlots(
  deps: VoiceSlotsDeps,
  n: number,
  opts: PlanFreeSlotsOptions,
): Promise<FreeSlotsPlan> {
  const target = { bookId: opts.bookId, issueId: opts.issueId };
  const [status, voices, castlist, needs] = await Promise.all([
    getSlotStatus(deps),
    readVoices(deps.supabase),
    readCastlist(deps.supabase),
    issueNeeds(deps.supabase, target),
  ]);
  const lastUsed = await lastUsedByVoice(deps.supabase, castlist);

  const freeNow = Math.max(0, status.voice_limit - status.voice_slots_used);
  const toArchive = Math.max(0, n - freeNow);
  const guard = { needs, excludeIds: opts.excludeIds };

  const refused: { voice: VoiceRow; refusals: ArchiveRefusal[] }[] = [];
  const candidates: VoiceRow[] = [];
  for (const v of voices) {
    if (v.status !== "active") continue;
    const cheap = archiveRefusalsCheap(v, guard);
    if (cheap.length > 0) refused.push({ voice: v, refusals: cheap });
    else candidates.push(v);
  }

  const ordered = orderCandidates(candidates, castlist, lastUsed, opts.bookId);
  const pick: VoiceRow[] = [];
  const spare: VoiceRow[] = [];
  for (const v of ordered) {
    if (pick.length >= toArchive) {
      spare.push(v);
      continue;
    }
    const refusals = await archiveRefusals(deps, v, guard);
    if (refusals.length > 0) refused.push({ voice: v, refusals });
    else pick.push(v);
  }

  const addEditHeadroom =
    status.max_voice_add_edits - status.voice_add_edit_counter;
  const refusals: string[] = [];
  if (pick.length < toArchive)
    refusals.push(
      `only ${pick.length} of ${toArchive} slots can be freed; ${refused.length} voice(s) refused`,
    );
  if (addEditHeadroom < n)
    refusals.push(
      `add/edit headroom ${addEditHeadroom} (${status.voice_add_edit_counter} of ${status.max_voice_add_edits} used) is below the ${n} add(s) needed`,
    );

  return {
    ok: refusals.length === 0,
    refusals,
    status,
    freeNow,
    toArchive,
    pick,
    spare,
    refused,
    addEditHeadroom,
  };
}

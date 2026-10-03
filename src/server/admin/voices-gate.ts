/**
 * The one check behind the voices stop (#353): the screen's Continue and
 * the resume endpoint both ask it before the `casting` hook resumes, so the
 * dashboard's Resume cannot skip the stop.
 *
 * It refuses while any item is unsettled: an open `casting_tasks` row
 * (pending or in progress), or a speaker for whom `voiceFor` finds no voice
 * and who has no "no audio this run" marker. `planCastingTasks` is the same
 * read the pipeline pauses on.
 */
import "server-only";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { loadBookCast } from "~/lib/cast";
import {
  planCastingTasks,
  pendingFromPlan,
} from "~/workflows/steps/casting-tasks";
import type { GateVerdict } from "~/server/admin/characters-gate";

export async function canContinueVoices(
  bookId: string,
  issueId: string,
): Promise<GateVerdict> {
  const plan = await planCastingTasks(supabaseAdmin, bookId, issueId);
  const count = pendingFromPlan(plan);
  if (count === 0) return { ok: true };

  const book = await loadBookCast(supabaseAdmin, bookId);
  const ids = [
    ...new Set([...plan.open.map((t) => t.characterId), ...plan.noVoice]),
  ];
  const names = ids.map((id) => book.resolve(id)?.display_name ?? id);
  const shown = names.slice(0, 5).join(", ");
  const more = names.length > 5 ? ` and ${names.length - 5} more` : "";
  return {
    ok: false,
    reason: `${count} voice ${count === 1 ? "item is" : "items are"} not settled: ${shown}${more}.`,
  };
}

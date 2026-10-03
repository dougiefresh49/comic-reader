/**
 * The one check behind the voices stop (#353): the screen's Continue and
 * the resume endpoint both ask it before the `casting` hook resumes, so the
 * dashboard's Resume cannot skip the stop.
 *
 * It refuses while any item is unsettled: an open `casting_tasks` row
 * (pending or in progress), or a speaker with no usable voice
 * (`hasUsableVoice`: an archived castlist voice is none) and no "no audio
 * this run" marker. `planCastingTasks` is the same
 * read the pipeline pauses on.
 */
import "server-only";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { loadBookCast } from "~/lib/cast";
import {
  planCastingTasks,
  pendingFromPlan,
  type CastingPlan,
} from "~/workflows/steps/casting-tasks";
import type { GateVerdict } from "~/server/admin/characters-gate";

/** The gate's plan and its verdict; the voices stop's loader lists the same `unsettled` ids. */
export async function readVoicesGate(
  bookId: string,
  issueId: string,
): Promise<{ plan: CastingPlan; verdict: GateVerdict }> {
  const plan = await planCastingTasks(supabaseAdmin, bookId, issueId);
  const count = pendingFromPlan(plan);
  if (count === 0) return { plan, verdict: { ok: true } };

  const book = await loadBookCast(supabaseAdmin, bookId);
  const names = plan.unsettled.map(
    (id) => book.resolve(id)?.display_name ?? id,
  );
  const shown = names.slice(0, 5).join(", ");
  const more = names.length > 5 ? ` and ${names.length - 5} more` : "";
  return {
    plan,
    verdict: {
      ok: false,
      reason: `${count} voice ${count === 1 ? "item is" : "items are"} not settled: ${shown}${more}.`,
    },
  };
}

export async function canContinueVoices(
  bookId: string,
  issueId: string,
): Promise<GateVerdict> {
  return (await readVoicesGate(bookId, issueId)).verdict;
}

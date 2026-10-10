"use server";

/**
 * Re-voice (#836): the casting page renders a character's old-voice bubbles
 * again, one render per call, so each call is short and the page shows
 * progress. Each render is the review editor's Regenerate (`regenerateAudio`),
 * so groups, cues, word timings and the `llm_calls` row are the same as for
 * one bubble there.
 */
import { supabaseAdmin } from "~/lib/supabase-admin";
import { requireAdmin } from "~/server/admin/require-admin";
import { regenerateAudio } from "~/server/actions/review/regenerate-audio";
import { planRevoice } from "./revoice-plan";

/**
 * Renders one unit of the character's plan, after reading the plan again: a
 * bubble that already plays its current voice (a rerun, another tab) is
 * skipped and spends nothing.
 */
export async function revoiceUnit(args: {
  bookId: string;
  issueId: string;
  bubbleId: string;
  characterId: string;
}): Promise<{ ok: true; skipped: boolean } | { ok: false; error: string }> {
  try {
    await requireAdmin();
    const [plan] = await planRevoice(supabaseAdmin, args.bookId, {
      characterIds: [args.characterId],
    });
    const unit = plan?.units.find(
      (u) => u.issueId === args.issueId && u.bubbleId === args.bubbleId,
    );
    if (!unit) return { ok: true, skipped: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const result = await regenerateAudio({
    bookId: args.bookId,
    issueId: args.issueId,
    bubbleId: args.bubbleId,
  });
  // Its error says what the reader plays now and whether it was paid for.
  if (!result.ok)
    return { ok: false, error: result.error ?? "Regenerate failed" };
  return { ok: true, skipped: false };
}

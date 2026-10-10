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
 * The bubbles a call on this server is checking or rendering now. A second
 * call for one of them (a box mounted again while the first box's call is in
 * flight) is refused before it reads the plan, so the two cannot both pay.
 */
const inFlight = new Set<string>();

/**
 * Renders one unit of the character's plan, after reading the plan again: a
 * bubble that already plays its current voice (a rerun, or another tab that
 * finished it first) is skipped and spends nothing.
 */
export async function revoiceUnit(args: {
  bookId: string;
  issueId: string;
  bubbleId: string;
  characterId: string;
}): Promise<
  { ok: true; skipped: boolean } | { ok: false; error: string; spent: boolean }
> {
  const claim = `${args.bookId}/${args.issueId}/${args.bubbleId}`;
  if (inFlight.has(claim))
    return {
      ok: false,
      error: "This line is already rendering in another Re-voice run.",
      spent: false,
    };
  inFlight.add(claim);
  try {
    return await checkAndRender(args);
  } finally {
    inFlight.delete(claim);
  }
}

async function checkAndRender(args: {
  bookId: string;
  issueId: string;
  bubbleId: string;
  characterId: string;
}): Promise<
  { ok: true; skipped: boolean } | { ok: false; error: string; spent: boolean }
> {
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
      spent: false,
    };
  }
  const result = await regenerateAudio({
    bookId: args.bookId,
    issueId: args.issueId,
    bubbleId: args.bubbleId,
  });
  // Its error says what the reader plays now. Every failure at or after the
  // paid call ends with "Regenerating will spend ElevenLabs credits again";
  // the ones before it (no text, a group to fix first) cost nothing.
  if (!result.ok) {
    const error = result.error ?? "Regenerate failed";
    return { ok: false, error, spent: error.includes("credits again") };
  }
  return { ok: true, skipped: false };
}

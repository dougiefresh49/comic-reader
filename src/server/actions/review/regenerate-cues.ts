"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { checkAdminAuth } from "~/lib/admin-auth";
import { cueRequest } from "~/lib/cue-rules";
import { getGeminiClient } from "~/lib/gemini-client";
import { generateContentLogged } from "~/lib/llm-usage";
import { revalidateReaderPages } from "~/lib/revalidate-reader";
import { supabaseAdmin } from "~/lib/supabase-admin";

interface Args {
  bookId: string;
  issueId: string;
  bubbleId: string;
  text: string;
  /** The bubble's emotion as the editor holds it; empty or null when none. */
  emotion: string | null;
  /** The bubble's speaker (character id) as the editor holds it; null when unassigned. */
  speaker: string | null;
  /**
   * Optional free-form guidance from the human reviewer about *why* the
   * previous cues didn't work. e.g. "voice should sound urgent, not mellow"
   * — Gemini uses this to drive the new formatting choice.
   */
  userFeedback?: string;
}

export async function regenerateCues(args: Args) {
  const auth = checkAdminAuth((await headers()).get("authorization"));
  if (!auth.ok) return { ok: false, error: auth.message };
  if (!args.text.trim()) {
    return { ok: false, error: "Empty text" };
  }

  // The bubble must be in this book and issue before Gemini is paid for.
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      args.bubbleId,
    );
  const bubbleQ = supabaseAdmin
    .from("bubbles")
    .select("id")
    .eq("book_id", args.bookId)
    .eq("issue_id", args.issueId);
  const { data: bubble, error: bErr } = await (isUuid
    ? bubbleQ.eq("id", args.bubbleId).maybeSingle()
    : bubbleQ.eq("legacy_id", args.bubbleId).maybeSingle());
  if (bErr) return { ok: false, error: bErr.message };
  if (!bubble) {
    return {
      ok: false,
      error: `Bubble ${args.bubbleId} not found in book ${args.bookId}, issue ${args.issueId}.`,
    };
  }

  try {
    const ai = getGeminiClient();
    const result = await generateContentLogged(
      ai,
      cueRequest({
        text: args.text,
        emotion: args.emotion,
        speaker: args.speaker,
        userFeedback: args.userFeedback,
      }),
      {
        step: "review:regenerate-cues",
        bookId: args.bookId,
        issueId: args.issueId,
      },
    );
    const formatted = result.text?.trim() ?? "";
    if (!formatted) return { ok: false, error: "Empty Gemini response" };

    // Update the bubble row in DB (mark needs_audio so audio re-gen picks it up)
    const query = supabaseAdmin
      .from("bubbles")
      .update({
        text_with_cues: formatted,
        needs_audio: true,
        updated_at: new Date().toISOString(),
      })
      .eq("book_id", args.bookId)
      .eq("issue_id", args.issueId);
    const { data, error } = await (
      isUuid
        ? query.eq("id", args.bubbleId)
        : query.eq("legacy_id", args.bubbleId)
    ).select("page_number");
    if (error) return { ok: false, error: error.message };
    if (!data?.length) {
      return {
        ok: false,
        error:
          "The cues were generated but not saved: no bubble row matched the update.",
      };
    }

    revalidatePath(
      `/admin/${args.bookId}/${args.issueId}/review/editor`,
      "page",
    );
    await revalidateReaderPages(
      args.bookId,
      args.issueId,
      data.map((row) => (row as { page_number: number }).page_number),
    );
    return { ok: true, textWithCues: formatted };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

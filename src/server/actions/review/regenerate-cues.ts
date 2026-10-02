"use server";

import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { checkAdminAuth } from "~/lib/admin-auth";
import { buildCuePrompt } from "~/lib/cue-rules";
import { generateContentLogged } from "~/lib/llm-usage";
import { GEMINI_FAST } from "~/lib/models";
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
  if (!process.env.GEMINI_API_KEY) {
    return { ok: false, error: "GEMINI_API_KEY not configured" };
  }
  if (!args.text.trim()) {
    return { ok: false, error: "Empty text" };
  }

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const result = await generateContentLogged(
      ai,
      {
        model: GEMINI_FAST,
        contents: buildCuePrompt({
          text: args.text,
          emotion: args.emotion,
          speaker: args.speaker,
          userFeedback: args.userFeedback,
        }),
        // No temperature: Google advises leaving Gemini 3 at its default,
        // since a low one risks looping (#104 drops it repo-wide). Low
        // thinking, because sentence case, the capitals to keep and a tag
        // that fits the emotion are judgment, not formatting.
        config: { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } },
      },
      {
        step: "review:regenerate-cues",
        bookId: args.bookId,
        issueId: args.issueId,
      },
    );
    const formatted = result.text?.trim() ?? "";
    if (!formatted) return { ok: false, error: "Empty Gemini response" };

    // Update the bubble row in DB (mark needs_audio so audio re-gen picks it up)
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        args.bubbleId,
      );
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

    revalidatePath(
      `/admin/${args.bookId}/${args.issueId}/review/editor`,
      "page",
    );
    await revalidateReaderPages(
      args.bookId,
      args.issueId,
      (data ?? []).map((row) => (row as { page_number: number }).page_number),
    );
    return { ok: true, textWithCues: formatted };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

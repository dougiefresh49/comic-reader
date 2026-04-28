"use server";

import { GoogleGenAI } from "@google/genai";
import { revalidatePath } from "next/cache";
import { GEMINI_FAST } from "~/lib/models";
import { supabaseAdmin } from "~/lib/supabase-admin";

function buildPrompt(text: string, userFeedback?: string): string {
  const feedbackBlock = userFeedback?.trim()
    ? `\n\nReviewer feedback (apply this to the cue choices):\n"${userFeedback.trim()}"\n`
    : "";

  return `You format dialogue text for ElevenLabs v3 TTS. Add ElevenLabs audio cues using the following rules:

1. Wrap onomatopoeia and shouts with capitalization for emphasis: "BOOM!", "AAAARGH!"
2. Use [whisper], [shouting], [emphasis], [laughs], [sigh], [urgent], [determined] inline tags when warranted by the emotion
3. Convert "..." to " — " for natural pauses
4. Preserve the original meaning EXACTLY — do not add new words or change the meaning
5. Output ONLY the formatted text, no explanation, no quotes, no surrounding markdown${feedbackBlock}

Input:
${text}

Formatted text:`;
}

interface Args {
  bookId: string;
  issueId: string;
  bubbleId: string;
  text: string;
  /**
   * Optional free-form guidance from the human reviewer about *why* the
   * previous cues didn't work. e.g. "voice should sound urgent, not mellow"
   * — Gemini uses this to drive the new formatting choice.
   */
  userFeedback?: string;
}

export async function regenerateCues(args: Args) {
  if (!process.env.GEMINI_API_KEY) {
    return { ok: false, error: "GEMINI_API_KEY not configured" };
  }
  if (!args.text.trim()) {
    return { ok: false, error: "Empty text" };
  }

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const result = await ai.models.generateContent({
      model: GEMINI_FAST,
      contents: buildPrompt(args.text, args.userFeedback),
      // When the user supplies feedback, allow a touch of variability so we
      // don't return the same output verbatim. Without feedback, stay
      // deterministic.
      config: { temperature: args.userFeedback?.trim() ? 0.3 : 0 },
    });
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
    const { error } = await (isUuid
      ? query.eq("id", args.bubbleId)
      : query.eq("legacy_id", args.bubbleId));
    if (error) return { ok: false, error: error.message };

    revalidatePath(`/book/${args.bookId}/${args.issueId}/review`, "page");
    return { ok: true, textWithCues: formatted };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

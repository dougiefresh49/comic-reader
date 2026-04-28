"use server";

import { GoogleGenAI } from "@google/genai";
import { revalidatePath } from "next/cache";
import { GEMINI_FAST } from "~/lib/models";
import { supabaseAdmin } from "~/lib/supabase-admin";

const PROMPT = `You format dialogue text for ElevenLabs v3 TTS. Add ElevenLabs audio cues using the following rules:

1. Wrap onomatopoeia and shouts with capitalization for emphasis: "BOOM!", "AAAARGH!"
2. Use [whisper], [shouting], [emphasis], [laughs], [sigh] inline tags ONLY if the emotion is clearly stated (e.g. screaming, whispering)
3. Convert "..." to " — " for natural pauses
4. Preserve the original meaning EXACTLY — do not add new words or change the meaning
5. Output ONLY the formatted text, no explanation, no quotes, no surrounding markdown

Input:
{TEXT}

Formatted text:`;

interface Args {
  bookId: string;
  issueId: string;
  bubbleId: string;
  text: string;
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
      contents: PROMPT.replace("{TEXT}", args.text),
      config: { temperature: 0 },
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

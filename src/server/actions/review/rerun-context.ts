"use server";

import {
  GoogleGenAI,
  createPartFromBase64,
  createPartFromText,
} from "@google/genai";
import { revalidatePath } from "next/cache";
import { GEMINI_MEDIUM } from "~/lib/models";
import { supabaseAdmin } from "~/lib/supabase-admin";

const PAGES_BUCKET = "comic-pages";

interface Args {
  bookId: string;
  issueId: string;
  bubbleId: string; // UUID or legacy_id
  /**
   * Base64 PNG/JPEG of the bubble crop, extracted client-side from the
   * already-loaded page image via canvas. Includes data: prefix or not.
   */
  cropBase64: string;
  /**
   * Optional free-form guidance from the human reviewer about what was
   * wrong with the previous output. e.g. "this is Master Splinter, not
   * the narrator". Helps Gemini avoid repeating the same mistake.
   */
  userFeedback?: string;
}

interface Result {
  ok: boolean;
  error?: string;
  speaker?: string | null;
  emotion?: string | null;
  type?: string | null;
  aiReasoning?: string | null;
}

interface BubbleRow {
  id: string;
  legacy_id: string | null;
  page_number: number;
  sort_order: number;
  ocr_text: string | null;
  text_with_cues: string | null;
  type: string;
  speaker: string | null;
  emotion: string | null;
  style: { left: string; top: string; width: string; height: string } | null;
}

function isUuid(id: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    id,
  );
}

function stripDataPrefix(s: string): { mime: string; data: string } {
  const m = /^data:([^;]+);base64,(.+)$/.exec(s);
  if (m?.[1] && m?.[2]) return { mime: m[1], data: m[2] };
  return { mime: "image/jpeg", data: s };
}

function buildPrompt(args: {
  targetSpeaker: string | null;
  targetText: string;
  pageNumber: number;
  uniqueCharacters: string[];
  pageBubbles: BubbleRow[];
  userFeedback?: string;
}): string {
  const known =
    args.uniqueCharacters.length > 0
      ? args.uniqueCharacters.join(", ")
      : "(none yet)";
  const pageContext = args.pageBubbles
    .map(
      (b) =>
        `  #${b.sort_order + 1} [${b.type}] ${b.speaker ?? "?"}: ${b.ocr_text?.slice(0, 80) ?? "(no text)"}`,
    )
    .join("\n");
  const feedbackBlock = args.userFeedback?.trim()
    ? `\n\nReviewer feedback (the previous attempt was wrong; correct it accordingly):\n"${args.userFeedback.trim()}"\n`
    : "";

  return `You are analyzing a single speech bubble inside a comic page. Two images are provided:
1. The full page (for layout / who else is in the panel)
2. A close-up crop of the bubble in question

Existing characters known to this issue: ${known}

Other bubbles on this page (in reading order):
${pageContext}

The bubble in question:
- Page: ${args.pageNumber}
- Current speaker: ${args.targetSpeaker ?? "(unknown)"}
- Current text: ${args.targetText || "(no OCR yet)"}${feedbackBlock}

Re-analyze who is speaking and what emotion they're conveying. Use scratchpad reasoning, then output strict JSON.

<scratchpad>
- Visual cues from the crop (tail direction, character on the panel, art style)
- Page-level context (who's in frame, narrative flow)
- Whether the OCR text matches a known character's voice
</scratchpad>

Then output ONLY this JSON object (no markdown):
{
  "speaker": "<canonical name or null>",
  "emotion": "<one or two words>",
  "type": "SPEECH | NARRATION | CAPTION | SFX | BACKGROUND"
}`;
}

export async function rerunContext(args: Args): Promise<Result> {
  if (!process.env.GEMINI_API_KEY) {
    return { ok: false, error: "GEMINI_API_KEY not configured" };
  }
  if (!args.cropBase64) {
    return { ok: false, error: "Missing crop image" };
  }

  // 1. Resolve target bubble
  const idCol = isUuid(args.bubbleId) ? "id" : "legacy_id";
  const { data: target, error: tErr } = await supabaseAdmin
    .from("bubbles")
    .select(
      "id, legacy_id, page_number, sort_order, ocr_text, text_with_cues, type, speaker, emotion, style",
    )
    .eq("book_id", args.bookId)
    .eq("issue_id", args.issueId)
    .eq(idCol, args.bubbleId)
    .maybeSingle();
  if (tErr || !target) {
    return { ok: false, error: tErr?.message ?? "Bubble not found" };
  }
  const t = target as BubbleRow;

  // 2. Fetch page image from Supabase Storage
  const padded = String(t.page_number).padStart(2, "0");
  const remotePath = `${args.bookId}/${args.issueId}/page-${padded}.webp`;
  const { data: pageBlob, error: pErr } = await supabaseAdmin.storage
    .from(PAGES_BUCKET)
    .download(remotePath);
  if (pErr || !pageBlob) {
    return {
      ok: false,
      error: `page fetch failed: ${pErr?.message ?? "no blob"}`,
    };
  }
  const pageBuffer = Buffer.from(await pageBlob.arrayBuffer());
  const pageBase64 = pageBuffer.toString("base64");

  // 3. Pull other bubbles on the same page for context
  const { data: pageBubbles } = await supabaseAdmin
    .from("bubbles")
    .select(
      "id, legacy_id, page_number, sort_order, ocr_text, text_with_cues, type, speaker, emotion, style",
    )
    .eq("book_id", args.bookId)
    .eq("issue_id", args.issueId)
    .eq("page_number", t.page_number)
    .order("sort_order");
  const neighbors = (pageBubbles ?? []) as BubbleRow[];

  // 4. Pull issue-level character set
  const { data: castRows } = await supabaseAdmin
    .from("castlist")
    .select("character")
    .eq("book_id", args.bookId)
    .eq("issue_id", args.issueId);
  const uniqueCharacters = (
    (castRows ?? []) as Array<{ character: string }>
  ).map((r) => r.character);

  // 5. Call Gemini with both images
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const { mime, data } = stripDataPrefix(args.cropBase64);

    const pagePart = createPartFromBase64(pageBase64, "image/webp");
    const cropPart = createPartFromBase64(data, mime);
    const textPart = createPartFromText(
      buildPrompt({
        targetSpeaker: t.speaker,
        targetText: t.text_with_cues ?? t.ocr_text ?? "",
        pageNumber: t.page_number,
        uniqueCharacters,
        pageBubbles: neighbors,
        userFeedback: args.userFeedback,
      }),
    );

    // Single-bubble vision with full neighbor context fits comfortably in
    // MEDIUM (Flash) — no need to spend Pro budget here. Switch to HIGH
    // only if quality drops below acceptable.
    const response = await ai.models.generateContent({
      model: GEMINI_MEDIUM,
      contents: [pagePart, cropPart, textPart],
    });
    const text = response.text?.trim();
    if (!text) return { ok: false, error: "Empty Gemini response" };

    let aiReasoning: string | null = null;
    const scratch = /<scratchpad>([\s\S]*?)<\/scratchpad>/i.exec(text);
    if (scratch) aiReasoning = scratch[1]?.trim() ?? null;

    let jsonText = text;
    const fence = /```json\s*([\s\S]*?)\s*```/.exec(jsonText);
    if (fence) jsonText = fence[1] ?? jsonText;
    const braceStart = jsonText.indexOf("{");
    const braceEnd = jsonText.lastIndexOf("}");
    if (braceStart === -1 || braceEnd === -1) {
      return { ok: false, error: "No JSON in Gemini response" };
    }
    let parsed: { speaker?: string | null; emotion?: string; type?: string };
    try {
      parsed = JSON.parse(jsonText.slice(braceStart, braceEnd + 1)) as {
        speaker?: string | null;
        emotion?: string;
        type?: string;
      };
    } catch {
      return { ok: false, error: "Failed to parse Gemini JSON" };
    }

    // 6. Persist to DB (also marks needs_audio if speaker / type changed)
    const patch: Record<string, unknown> = {};
    if (parsed.speaker !== undefined) patch.speaker = parsed.speaker ?? null;
    if (parsed.emotion !== undefined) patch.emotion = parsed.emotion;
    if (parsed.type !== undefined) patch.type = parsed.type;
    if (aiReasoning !== null) patch.ai_reasoning = aiReasoning;

    const speakerChanged =
      parsed.speaker !== undefined && parsed.speaker !== t.speaker;
    const typeChanged = parsed.type !== undefined && parsed.type !== t.type;
    if (speakerChanged || typeChanged) patch.needs_audio = true;
    patch.updated_at = new Date().toISOString();

    const { error: uErr } = await supabaseAdmin
      .from("bubbles")
      .update(patch)
      .eq("id", t.id);
    if (uErr) return { ok: false, error: uErr.message };

    revalidatePath(`/book/${args.bookId}/${args.issueId}/review`, "page");
    return {
      ok: true,
      speaker: parsed.speaker ?? null,
      emotion: parsed.emotion ?? null,
      type: parsed.type ?? null,
      aiReasoning,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

"use server";

// The review editor's analyze: two Gemini calls, as get-context makes them
// (#437, #460). The speaker call proposes the bubble's type, speaker, emotion
// and, for an empty box, its text; the cue call (`cueRequest`, the one Regenerate
// cues sends) writes the cue line from that text, speaker and emotion. It writes
// no bubble; the editor shows the proposal and the owner accepts it into the
// pending edits.
import { createPartFromBase64, createPartFromText } from "@google/genai";
import { headers } from "next/headers";
import { NARRATOR_ID, resolveSpeaker } from "~/components/review-editor/lib";
import { BUBBLE_TYPES, type BubbleType } from "~/lib/bubble-types";
import { checkAdminAuth } from "~/lib/admin-auth";
import { cueRequest } from "~/lib/cue-rules";
import { getGeminiClient } from "~/lib/gemini-client";
import { buildContextPrompt } from "~/lib/gemini-prompts";
import { generateContentLogged } from "~/lib/llm-usage";
import { GEMINI_FAST } from "~/lib/models";
import { pageStoragePath } from "~/lib/storage";
import { supabaseAdmin } from "~/lib/supabase-admin";

const PAGES_BUCKET = "comic-pages";
/** Server actions take 1 MB; the editor scales the crop well under this. */
const MAX_CROP_CHARS = 900_000;
const MAX_HINT_CHARS = 500;

/** One entry of the editor's closed speaker list. */
export interface AnalyzeCastEntry {
  id: string;
  name: string;
  aliases: string[];
}

export interface AnalyzeArgs {
  bookId: string;
  issueId: string;
  pageNumber: number;
  /** The box in pixels of the page image, the shape the pipeline's prompt takes. */
  box: { x: number; y: number; width: number; height: number };
  /** The bubble's text now. Empty asks the model to read it from the page. */
  text: string;
  /** JPEG or PNG of the box, cut in the browser, with or without a data: prefix. */
  cropBase64: string;
  /** The editor's closed list: the cast plus narrator, off-panel and crowd. */
  cast: AnalyzeCastEntry[];
  /** "it's the Yellow Ranger, she is angry". */
  hint?: string;
}

export interface AnalyzeProposal {
  /** "" when the model read no words in the box. */
  text: string;
  /** null when there is no text to cue, so nothing writes an empty `text_with_cues`. */
  textWithCues: string | null;
  /** A cast id from the list that was sent, or "" when the model named none on it. */
  speaker: string;
  emotion: string;
  type: BubbleType;
}

export type AnalyzeResult =
  | {
      ok: true;
      proposal: AnalyzeProposal;
      /**
       * Set when the cue call failed or came back empty. The proposal still
       * holds call 1's answer, with the plain text as its cue line.
       */
      cueError?: string;
    }
  | { ok: false; error: string };

interface Parsed {
  type?: unknown;
  speaker?: unknown;
  emotion?: unknown;
  text?: unknown;
}

function stripDataPrefix(s: string): { mime: string; data: string } {
  const m = /^data:([^;]+);base64,(.+)$/.exec(s);
  if (m?.[1] && m?.[2]) return { mime: m[1], data: m[2] };
  return { mime: "image/jpeg", data: s };
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function invalid(args: AnalyzeArgs): string | null {
  if (!args.bookId || !args.issueId) return "Missing book or issue";
  if (!Number.isInteger(args.pageNumber) || args.pageNumber < 1)
    return "Bad page number";
  const { x, y, width, height } = args.box ?? {};
  if (![x, y, width, height].every((n) => Number.isFinite(n))) return "Bad box";
  if (width <= 0 || height <= 0) return "Empty box";
  if (!args.cropBase64) return "Missing crop image";
  if (args.cropBase64.length > MAX_CROP_CHARS) return "Crop image too large";
  if (!Array.isArray(args.cast)) return "Missing cast list";
  return null;
}

export async function analyzeBubble(args: AnalyzeArgs): Promise<AnalyzeResult> {
  const auth = checkAdminAuth((await headers()).get("authorization"));
  if (!auth.ok) return { ok: false, error: auth.message };
  if (!process.env.GEMINI_API_KEY) {
    return { ok: false, error: "GEMINI_API_KEY not configured" };
  }
  const bad = invalid(args);
  if (bad) return { ok: false, error: bad };

  const { data: pageBlob, error: pErr } = await supabaseAdmin.storage
    .from(PAGES_BUCKET)
    .download(pageStoragePath(args.bookId, args.issueId, args.pageNumber));
  if (pErr || !pageBlob) {
    return {
      ok: false,
      error: `page fetch failed: ${pErr?.message ?? "no blob"}`,
    };
  }
  const pageBase64 = Buffer.from(await pageBlob.arrayBuffer()).toString(
    "base64",
  );

  const current = args.text.trim();
  const transcribe = current === "";
  const hint = args.hint?.trim().slice(0, MAX_HINT_CHARS);
  const prompt = buildContextPrompt(
    current,
    {
      x: Math.round(args.box.x),
      y: Math.round(args.box.y),
      width: Math.round(args.box.width),
      height: Math.round(args.box.height),
    },
    args.cast.map((c) => c.name),
    hint
      ? `Reviewer's hint for this bubble, from the person checking the book. Follow it: "${hint}"`
      : undefined,
    { closedList: true, transcribe, crop: true, noCues: true },
  );
  const meta = {
    bookId: args.bookId,
    issueId: args.issueId,
    pageNumber: args.pageNumber,
  };

  const ai = getGeminiClient();
  let proposal: AnalyzeProposal;
  try {
    const { mime, data } = stripDataPrefix(args.cropBase64);
    const response = await generateContentLogged(
      ai,
      {
        model: GEMINI_FAST,
        contents: [
          createPartFromBase64(pageBase64, "image/webp"),
          createPartFromBase64(data, mime),
          createPartFromText(prompt),
        ],
      },
      { step: "review:analyze-bubble", ...meta },
    );
    const reply = response.text?.trim();
    if (!reply) return { ok: false, error: "Empty Gemini response" };

    // The JSON sits after the scratchpad, in a fence or bare.
    let jsonText = reply.replace(/<scratchpad>[\s\S]*?<\/scratchpad>/i, "");
    const fence = /```json\s*([\s\S]*?)\s*```/.exec(jsonText);
    if (fence) jsonText = fence[1] ?? jsonText;
    const braceStart = jsonText.indexOf("{");
    const braceEnd = jsonText.lastIndexOf("}");
    if (braceStart === -1 || braceEnd === -1) {
      return { ok: false, error: "No JSON in Gemini response" };
    }
    let parsed: Parsed;
    try {
      parsed = JSON.parse(jsonText.slice(braceStart, braceEnd + 1)) as Parsed;
    } catch {
      return { ok: false, error: "Failed to parse Gemini JSON" };
    }

    const text = transcribe ? str(parsed.text) : current;
    const type = BUBBLE_TYPES.find((t) => t === str(parsed.type).toUpperCase());
    // The closed list, enforced: a name not on it never reaches the editor.
    const resolved = resolveSpeaker(str(parsed.speaker) || null, args.cast);
    // A narration box with no speaker named is the Narrator's: that is what
    // Accept stores (`patchBubble` in the editor's model) and what get-context
    // sends to the cue call, so the cue line is written for that voice.
    const speaker = resolved ?? (type === "NARRATION" ? NARRATOR_ID : null);

    proposal = {
      text,
      textWithCues: null,
      speaker: speaker ?? "",
      emotion: str(parsed.emotion) || "neutral",
      type: type ?? "SPEECH",
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  // A box with no words has nothing to cue.
  if (!proposal.text) return { ok: true, proposal };

  // The cue line, from the text, speaker and emotion the proposal carries. The
  // reviewer's hint went to the speaker call; `userFeedback` is feedback on an
  // earlier cue line, so it stays unset. A failed or empty reply keeps the
  // speaker proposal, with the plain text as the cue line.
  let cueError: string;
  try {
    const response = await generateContentLogged(
      ai,
      cueRequest({
        text: proposal.text,
        emotion: proposal.emotion,
        speaker: proposal.speaker || null,
      }),
      { step: "review:analyze-bubble:cues", ...meta },
    );
    const cueLine = response.text?.trim();
    if (cueLine) {
      return { ok: true, proposal: { ...proposal, textWithCues: cueLine } };
    }
    cueError = "Empty Gemini response from the cue call";
  } catch (e) {
    cueError = `cue call failed: ${(e as Error).message}`;
  }
  console.warn(
    `[analyze-bubble] ${args.bookId}/${args.issueId} page ${args.pageNumber}: ${cueError}`,
  );
  return {
    ok: true,
    proposal: { ...proposal, textWithCues: proposal.text },
    cueError,
  };
}

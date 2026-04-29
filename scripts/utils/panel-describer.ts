/**
 * Per-panel Gemini description.
 *
 * Crops the page WebP to a single panel's bounding box (with a small
 * margin) and sends only that crop to GEMINI_MEDIUM along with the
 * panel's bubbles' OCR text + speakers. Returns a cinematic description
 * + effect tags + audio tags clamped to the canonical enums.
 *
 * Why MEDIUM: Pro is rate-limited (250/day) and this would push us
 * past it on a single book run. FAST hallucinates too much for visual
 * grounding work. MEDIUM is the right tier — vision-capable, reliable
 * enough on cropped panels which are simpler than full pages.
 *
 * Design intent: each pipeline pass narrows context. By the time we
 * hit describe-panels we already know:
 *  - The panel rect (Roboflow)
 *  - Which bubbles speak inside it (FK assignment)
 *  - Each bubble's OCR / speaker / emotion (get-context)
 *
 * So this prompt asks Gemini to produce only what's still missing:
 * cinematic vocabulary + effect / audio tags. It does NOT need to
 * re-derive who is in the panel or what they are saying.
 */

import {
  GoogleGenAI,
  createPartFromBase64,
  createPartFromText,
} from "@google/genai";
import sharp from "sharp";
import {
  AMBIENCE_TAGS,
  EFFECT_TAGS,
  MUSIC_MOODS,
  SFX_TAGS,
  type AmbienceTag,
  type AudioTags,
  type EffectTag,
  type MusicMood,
  type SfxTag,
} from "./panel-director.js";

export interface PanelBubbleSummary {
  /** legacy_id e.g. "page-03_b01" — for traceability in the prompt */
  legacyId?: string | null;
  type: string;
  speaker: string | null;
  emotion: string | null;
  text: string;
}

export interface PanelDescription {
  cinematicDescription: string;
  effectTags: EffectTag[];
  audioTags: AudioTags;
}

interface GeminiResponse {
  cinematicDescription?: string;
  effectTags?: string[];
  audioTags?: {
    ambience?: string[];
    sfx?: string[];
    music_mood?: string;
  };
}

function clampToEnum<T extends readonly string[]>(
  value: unknown,
  values: T,
  fallback: T[number],
): T[number] {
  if (
    typeof value === "string" &&
    (values as readonly string[]).includes(value)
  ) {
    return value as T[number];
  }
  return fallback;
}

function clampArrayToEnum<T extends readonly string[]>(
  values: unknown,
  enumValues: T,
  max: number,
): T[number][] {
  if (!Array.isArray(values)) return [];
  const out: T[number][] = [];
  const seen = new Set<string>();
  for (const v of values) {
    if (
      typeof v === "string" &&
      (enumValues as readonly string[]).includes(v) &&
      !seen.has(v)
    ) {
      out.push(v as T[number]);
      seen.add(v);
      if (out.length >= max) break;
    }
  }
  return out;
}

function parseGeminiJson(text: string): GeminiResponse {
  let json = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(json);
  if (fence?.[1]) json = fence[1];
  const start = json.indexOf("{");
  const end = json.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error("No JSON object in Gemini response");
  }
  return JSON.parse(json.slice(start, end + 1)) as GeminiResponse;
}

/**
 * Crop the page image to the panel's bounding box plus a small margin so
 * the panel border and adjacent visual context stay in frame. Returns
 * a JPEG buffer (smaller than WebP for Gemini's request body).
 */
export async function cropPageToPanel(
  pageImageBuffer: Buffer,
  bbox: { x: number; y: number; w: number; h: number },
  marginPct = 0.02,
): Promise<Buffer> {
  const meta = await sharp(pageImageBuffer).metadata();
  const W = meta.width ?? 1;
  const H = meta.height ?? 1;
  const mx = bbox.w * marginPct;
  const my = bbox.h * marginPct;
  const left = Math.max(0, Math.floor((bbox.x - mx) * W));
  const top = Math.max(0, Math.floor((bbox.y - my) * H));
  const right = Math.min(W, Math.ceil((bbox.x + bbox.w + mx) * W));
  const bottom = Math.min(H, Math.ceil((bbox.y + bbox.h + my) * H));
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  return sharp(pageImageBuffer)
    .extract({ left, top, width, height })
    .jpeg({ quality: 85 })
    .toBuffer();
}

function buildPrompt(args: {
  bookFranchise: string | null;
  bubbles: PanelBubbleSummary[];
  isFullPagePanel: boolean;
}): string {
  const bubbleLines = args.bubbles.length
    ? args.bubbles
        .map((b) => {
          const t = (b.text ?? "").replace(/\s+/g, " ").slice(0, 140);
          const emo = b.emotion ? ` [${b.emotion}]` : "";
          return `- ${b.type} ${b.speaker ?? "?"}${emo}: "${t}"`;
        })
        .join("\n")
    : "(no dialogue in this panel — describe the visual only)";

  const fullPageNote = args.isFullPagePanel
    ? "\nThis is a full-page panel (no smaller subdivision). Describe the dominant composition."
    : "";

  return `You are describing a single comic-book panel for a motion-comic web renderer.

The image attached is the panel itself (already cropped). The bubbles inside it have already been transcribed:
${bubbleLines}${fullPageNote}

Return strict JSON only (no markdown fences):
{
  "cinematicDescription": "...",
  "effectTags": ["...", "..."],
  "audioTags": {
    "ambience": ["..."],
    "sfx": ["..."],
    "music_mood": "..."
  }
}

cinematicDescription rules:
- One sentence in cinematic vocabulary ("low-angle wide shot — neon-lit rooftop in driving rain — two armored figures square off — tense").
- NEVER mention IP / character names. Describe characters only by visible traits.
  Example: "an anthropomorphic turtle in a blue mask wielding twin katanas" not "Leonardo".
- Avoid proper nouns from real-world IP (brands, vehicles, locations). Generic descriptors only.
- Favor cinematic vocabulary as a content-filter shield: "depth of field", "rim lighting", "low-angle", "Dutch angle", "tracking shot", "lens flare".

effectTags must be 1–4 entries from this enum (no other strings allowed):
${JSON.stringify([...EFFECT_TAGS])}

audioTags.ambience must be 0–2 entries from:
${JSON.stringify([...AMBIENCE_TAGS])}

audioTags.sfx must be 0–3 entries from:
${JSON.stringify([...SFX_TAGS])}

audioTags.music_mood must be exactly one of:
${JSON.stringify([...MUSIC_MOODS])}

Output the JSON object directly. No commentary, no markdown fences.`;
}

/**
 * Send the panel crop + bubble summary to Gemini. Returns clamped output
 * with safe defaults if Gemini returns garbage on any field.
 */
export async function describeSinglePanel(args: {
  gemini: GoogleGenAI;
  geminiModel: string;
  panelCropJpeg: Buffer;
  bubbles: PanelBubbleSummary[];
  isFullPagePanel: boolean;
  bookFranchise?: string | null;
}): Promise<PanelDescription> {
  const imagePart = createPartFromBase64(
    args.panelCropJpeg.toString("base64"),
    "image/jpeg",
  );
  const textPart = createPartFromText(
    buildPrompt({
      bookFranchise: args.bookFranchise ?? null,
      bubbles: args.bubbles,
      isFullPagePanel: args.isFullPagePanel,
    }),
  );

  const response = await args.gemini.models.generateContent({
    model: args.geminiModel,
    contents: [imagePart, textPart],
  });
  const text = response.text?.trim();
  if (!text) {
    throw new Error("Empty Gemini response");
  }

  const raw = parseGeminiJson(text);
  return {
    cinematicDescription: (raw.cinematicDescription ?? "").trim(),
    effectTags: clampArrayToEnum(raw.effectTags, EFFECT_TAGS, 4),
    audioTags: {
      ambience: clampArrayToEnum(raw.audioTags?.ambience, AMBIENCE_TAGS, 2),
      sfx: clampArrayToEnum(raw.audioTags?.sfx, SFX_TAGS, 3),
      music_mood: clampToEnum(
        raw.audioTags?.music_mood,
        MUSIC_MOODS,
        "transition_neutral",
      ),
    },
  };
}

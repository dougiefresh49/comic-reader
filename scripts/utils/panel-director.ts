/**
 * Phase: motion-comic-plus / panel direction.
 *
 * Per-page Gemini Vision call that returns panels with bounding boxes +
 * cinematic descriptions + effect/audio tags. Inputs include the cached
 * per-bubble aiReasoning from data/gemini-context/, the page's bubble
 * manifest, and a one-line summary of the previous page so Gemini can
 * make a well-grounded scene-continuity call.
 *
 * Outputs are written to the `panels` table (one row per panel) and
 * each bubble's `panel_id` FK is updated to point at its assigned panel.
 *
 * Reddit-derived hardening: cinematic descriptions never include IP/
 * character names — characters live separately in bubbles.speaker.
 */

import {
  GoogleGenAI,
  createPartFromBase64,
  createPartFromText,
} from "@google/genai";

// ─── Effect / audio tag enums ─────────────────────────────────────────────────
// Canonical source of truth lives in src/lib/panel-tags.ts so the browser
// review UI can import without pulling scripts/. Re-exported here for
// backwards compatibility with existing pipeline imports.

import {
  EFFECT_TAGS,
  AMBIENCE_TAGS,
  SFX_TAGS,
  MUSIC_MOODS,
} from "~/lib/panel-tags.js";
import type {
  EffectTag,
  AmbienceTag,
  SfxTag,
  MusicMood,
  AudioTags,
} from "~/lib/panel-tags.js";

export { EFFECT_TAGS, AMBIENCE_TAGS, SFX_TAGS, MUSIC_MOODS };
export type { EffectTag, AmbienceTag, SfxTag, MusicMood, AudioTags };

// ─── Public types ─────────────────────────────────────────────────────────────

export interface BoundingBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DirectedPanel {
  panelId: string;
  pageNumber: number;
  sortOrder: number;
  boundingBox: BoundingBox;
  cinematicDescription: string;
  effectTags: EffectTag[];
  audioTags: AudioTags;
  bubbleIds: string[]; // legacy_id values from bubbles
  primarySpeaker: string | null;
  estimatedDurationSeconds: number;
  isNewScene: boolean;
}

export interface PageDirection {
  pageNumber: number;
  settingSummary: string;
  isNewScene: boolean;
  panels: DirectedPanel[];
}

export interface PanelDirection {
  bookId: string;
  issueId: string;
  generatedAt: string;
  pages: PageDirection[];
}

// ─── Inputs ───────────────────────────────────────────────────────────────────

interface BubbleStyle {
  left: string;
  top: string;
  width: string;
  height: string;
}

export interface BubbleManifestEntry {
  id: string;
  type: "SPEECH" | "NARRATION" | "CAPTION" | "SFX" | "BACKGROUND";
  speaker: string | null;
  emotion?: string | null;
  textWithCues?: string | null;
  ocr_text?: string | null;
  ignored?: boolean;
  style?: BubbleStyle;
}

export interface AudioTimestamp {
  alignment?: { character_end_times_seconds?: number[] } | null;
  normalized_alignment?: {
    character_end_times_seconds?: number[];
  } | null;
}

interface CachedReasoningEntry {
  id?: string;
  speaker?: string | null;
  type?: string;
  ocr_text?: string;
  textWithCues?: string;
  aiReasoning?: string;
}

// ─── Gemini call ──────────────────────────────────────────────────────────────

interface GeminiPanelsResponse {
  panels: Array<{
    panelId?: string;
    boundingBox?: BoundingBox;
    cinematicDescription?: string;
    effectTags?: string[];
    audioTags?: {
      ambience?: string[];
      sfx?: string[];
      music_mood?: string;
    };
    bubbleIds?: string[];
    primarySpeaker?: string | null;
    estimatedDurationSeconds?: number;
  }>;
  settingSummary?: string;
  isNewScene?: boolean;
}

function compactReasoning(entries: CachedReasoningEntry[]): string {
  if (!entries.length) return "(no cached per-bubble reasoning)";
  return entries
    .map((e) => {
      const id = e.id ?? "?";
      const speaker = e.speaker ?? "?";
      const reasoning = (e.aiReasoning ?? "")
        .replace(/\s+/g, " ")
        .slice(0, 240);
      return `- ${id} [${speaker}]: ${reasoning}`;
    })
    .join("\n");
}

function compactBubbleManifest(bubbles: BubbleManifestEntry[]): string {
  return bubbles
    .map((b) => {
      const s = b.style;
      const pos = s
        ? `(${s.left}, ${s.top}, ${s.width}×${s.height})`
        : "(no-pos)";
      const text = (b.textWithCues ?? b.ocr_text ?? "")
        .replace(/\s+/g, " ")
        .slice(0, 80);
      return `- ${b.id} ${b.type} ${b.speaker ?? "?"} ${pos}: ${text}`;
    })
    .join("\n");
}

function buildPrompt(args: {
  pageNumber: number;
  isFirstPage: boolean;
  previousPageSummary: string | null;
  bubbleManifest: BubbleManifestEntry[];
  cachedReasoning: CachedReasoningEntry[];
}): string {
  const prevContext = args.isFirstPage
    ? `This is page 1 of the issue. Mark isNewScene=true.`
    : args.previousPageSummary
      ? `Previous page setting: "${args.previousPageSummary}". Compare and decide if this page is a meaningfully different scene.`
      : `Previous page summary not available — judge scene continuity from your own analysis.`;

  return `You are a panel-direction analyst for a motion comic. The page image is attached.

Context already gathered:
- ${prevContext}
- Bubble manifest for this page (id / type / speaker / position / snippet):
${compactBubbleManifest(args.bubbleManifest)}

- Per-bubble visual reasoning from a previous Gemini pass (already paid for, treat as ground truth):
${compactReasoning(args.cachedReasoning)}

Your job: for each visually distinct panel on the page, return a record describing it for the motion-comic renderer. Panels can span multiple speech bubbles. Multiple bubbles in the same scene can share a panel.

Strict rules:
1. NEVER mention IP/character names ("Spider-Man", "Splinter", "Donatello") in cinematicDescription. Describe characters by visible traits only ("an anthropomorphic turtle in a blue mask wielding twin katanas"). Cinematic vocabulary is your shield: prefer "depth of field", "low-angle wide shot", "rim lighting", "tracking shot", "lens flare".
2. Every bubble in the manifest must be assigned to exactly one panel via bubbleIds. The bubble id must come from the manifest above.
3. effectTags must be 1–4 entries from this enum:
${JSON.stringify([...EFFECT_TAGS])}
4. audioTags.ambience must be 0–2 entries from:
${JSON.stringify([...AMBIENCE_TAGS])}
5. audioTags.sfx must be 0–3 entries from:
${JSON.stringify([...SFX_TAGS])}
6. audioTags.music_mood must be exactly one of:
${JSON.stringify([...MUSIC_MOODS])}
7. boundingBox is { x, y, w, h } as 0..1 fractions of the page (top-left origin). Panels can overlap slightly but should mostly tile the page.
8. panelId is "p${String(args.pageNumber).padStart(2, "0")}-NN" sequential.
9. estimatedDurationSeconds: 1s lead-in + sum of bubble durations + 1s tail (you don't have durations; estimate ~3s per dialogue bubble, ~4s per narration line).

Also return:
- settingSummary: ONE sentence describing this page's setting/location — feeds into the next page's context.
- isNewScene: true if this page's setting is materially different from the previous page.

Respond with strict JSON, no markdown fences:
{
  "settingSummary": "...",
  "isNewScene": false,
  "panels": [
    {
      "panelId": "p${String(args.pageNumber).padStart(2, "0")}-01",
      "boundingBox": { "x": 0, "y": 0, "w": 1, "h": 0.5 },
      "cinematicDescription": "...",
      "effectTags": ["camera_push_in_slow"],
      "audioTags": { "ambience": [], "sfx": [], "music_mood": "transition_neutral" },
      "bubbleIds": ["page-${String(args.pageNumber).padStart(2, "0")}_b01"],
      "primarySpeaker": "Narrator",
      "estimatedDurationSeconds": 5
    }
  ]
}`;
}

function parseGeminiJson(text: string): GeminiPanelsResponse {
  let json = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(json);
  if (fence?.[1]) json = fence[1];
  const start = json.indexOf("{");
  const end = json.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error("No JSON object in Gemini response");
  }
  return JSON.parse(json.slice(start, end + 1)) as GeminiPanelsResponse;
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
  for (const v of values) {
    if (
      typeof v === "string" &&
      (enumValues as readonly string[]).includes(v)
    ) {
      out.push(v as T[number]);
      if (out.length >= max) break;
    }
  }
  return out;
}

function bubbleDurationSeconds(ts: AudioTimestamp | undefined): number {
  if (!ts) return 0;
  const ends =
    ts.normalized_alignment?.character_end_times_seconds ??
    ts.alignment?.character_end_times_seconds;
  if (!ends || ends.length === 0) return 0;
  return ends[ends.length - 1] ?? 0;
}

export async function directPagePanels(args: {
  gemini: GoogleGenAI;
  geminiModel: string;
  pageNumber: number;
  pageImageBuffer: Buffer;
  bubbleManifest: BubbleManifestEntry[];
  cachedReasoning: CachedReasoningEntry[];
  audioTimestamps: Record<string, AudioTimestamp>;
  previousPageSummary: string | null;
  isFirstPage: boolean;
}): Promise<PageDirection> {
  const prompt = buildPrompt({
    pageNumber: args.pageNumber,
    isFirstPage: args.isFirstPage,
    previousPageSummary: args.previousPageSummary,
    bubbleManifest: args.bubbleManifest,
    cachedReasoning: args.cachedReasoning,
  });

  const imagePart = createPartFromBase64(
    args.pageImageBuffer.toString("base64"),
    "image/webp",
  );
  const textPart = createPartFromText(prompt);

  const response = await args.gemini.models.generateContent({
    model: args.geminiModel,
    contents: [imagePart, textPart],
  });
  const text = response.text?.trim();
  if (!text)
    throw new Error(`Empty Gemini response for page ${args.pageNumber}`);

  const raw = parseGeminiJson(text);
  const validBubbleIds = new Set(args.bubbleManifest.map((b) => b.id));

  // Sanitize and clamp Gemini's output to enums; recompute durations from
  // real audio timestamps rather than trusting Gemini's estimate.
  const panels: DirectedPanel[] = (raw.panels ?? []).map((p, idx) => {
    const sortOrder = idx;
    const panelId =
      typeof p.panelId === "string" && p.panelId.length > 0
        ? p.panelId
        : `p${String(args.pageNumber).padStart(2, "0")}-${String(idx + 1).padStart(2, "0")}`;

    const bb = p.boundingBox ?? { x: 0, y: 0, w: 1, h: 1 };
    const boundingBox: BoundingBox = {
      x: Math.max(0, Math.min(1, Number(bb.x) || 0)),
      y: Math.max(0, Math.min(1, Number(bb.y) || 0)),
      w: Math.max(0, Math.min(1, Number(bb.w) || 0)),
      h: Math.max(0, Math.min(1, Number(bb.h) || 0)),
    };

    const bubbleIds = (p.bubbleIds ?? []).filter(
      (id): id is string => typeof id === "string" && validBubbleIds.has(id),
    );

    const realDuration =
      bubbleIds.reduce(
        (acc, id) => acc + bubbleDurationSeconds(args.audioTimestamps[id]),
        0,
      ) +
      Math.max(0.3, bubbleIds.length * 0.3) +
      2.0; // 1s lead + 1s tail

    return {
      panelId,
      pageNumber: args.pageNumber,
      sortOrder,
      boundingBox,
      cinematicDescription: (p.cinematicDescription ?? "").trim(),
      effectTags: clampArrayToEnum(p.effectTags, EFFECT_TAGS, 4),
      audioTags: {
        ambience: clampArrayToEnum(p.audioTags?.ambience, AMBIENCE_TAGS, 2),
        sfx: clampArrayToEnum(p.audioTags?.sfx, SFX_TAGS, 3),
        music_mood: clampToEnum(
          p.audioTags?.music_mood,
          MUSIC_MOODS,
          "transition_neutral",
        ),
      },
      bubbleIds,
      primarySpeaker:
        typeof p.primarySpeaker === "string" ? p.primarySpeaker : null,
      estimatedDurationSeconds:
        bubbleIds.length > 0
          ? Math.round(realDuration * 10) / 10
          : Number(p.estimatedDurationSeconds) || 3.5,
      isNewScene: false, // page-level field; copied below
    };
  });

  // Backfill: any bubbles in the manifest that didn't get assigned to a
  // panel get pinned to the closest panel by bbox center.
  const assigned = new Set(panels.flatMap((p) => p.bubbleIds));
  const unassigned = args.bubbleManifest.filter(
    (b) =>
      !assigned.has(b.id) &&
      !b.ignored &&
      b.type !== "SFX" &&
      b.type !== "BACKGROUND",
  );
  if (unassigned.length > 0 && panels.length > 0) {
    for (const bubble of unassigned) {
      const cx =
        (parseFloat(bubble.style?.left ?? "0") +
          parseFloat(bubble.style?.width ?? "0") / 2) /
        100;
      const cy =
        (parseFloat(bubble.style?.top ?? "0") +
          parseFloat(bubble.style?.height ?? "0") / 2) /
        100;
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < panels.length; i++) {
        const p = panels[i]!.boundingBox;
        const px = p.x + p.w / 2;
        const py = p.y + p.h / 2;
        const d = Math.hypot(px - cx, py - cy);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      panels[bestIdx]!.bubbleIds.push(bubble.id);
    }
  }

  // If Gemini returned no panels but we have bubbles, fabricate a single
  // full-page panel so nothing is lost. This is a soft-fail path; the user
  // can hand-edit in the panel review UI.
  if (panels.length === 0 && args.bubbleManifest.length > 0) {
    panels.push({
      panelId: `p${String(args.pageNumber).padStart(2, "0")}-01`,
      pageNumber: args.pageNumber,
      sortOrder: 0,
      boundingBox: { x: 0, y: 0, w: 1, h: 1 },
      cinematicDescription: "wide establishing shot — page-level scene",
      effectTags: ["camera_push_in_slow"],
      audioTags: {
        ambience: [],
        sfx: [],
        music_mood: "transition_neutral",
      },
      bubbleIds: args.bubbleManifest
        .filter(
          (b) => !b.ignored && b.type !== "SFX" && b.type !== "BACKGROUND",
        )
        .map((b) => b.id),
      primarySpeaker: null,
      estimatedDurationSeconds: 4,
      isNewScene: false,
    });
  }

  const isNewScene = args.isFirstPage || raw.isNewScene === true ? true : false;
  // Mark first panel as newScene marker so music transitions trigger
  if (panels.length > 0 && isNewScene) {
    panels[0]!.isNewScene = true;
  }

  return {
    pageNumber: args.pageNumber,
    settingSummary: (raw.settingSummary ?? "").trim(),
    isNewScene,
    panels,
  };
}

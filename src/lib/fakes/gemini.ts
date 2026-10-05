import { createHash } from "node:crypto";
import type { GoogleGenAI } from "@google/genai";
import {
  isGatesScenario,
  loadIngestFixture,
  logSpend,
  type FixtureBubble,
} from "./dry-run";
import { resetRoboflowCursor } from "./roboflow";

const EMBEDDING_DIMENSIONS = 768;

/** Every text part in a `contents` value, in order. */
function textParts(contents: unknown): string[] {
  if (typeof contents === "string") return [contents];
  if (Array.isArray(contents)) return contents.flatMap(textParts);
  if (contents && typeof contents === "object") {
    const c = contents as { text?: unknown; parts?: unknown };
    if (typeof c.text === "string") return [c.text];
    if (c.parts) return textParts(c.parts);
  }
  return [];
}

function allBubbles(): FixtureBubble[] {
  return loadIngestFixture().pages.flatMap((p) => p.bubbles);
}

let ocrCursor = 0;
let faceCursor = 0;

/**
 * Reset every call-order cursor the fakes keep (OCR, face ID, Roboflow
 * base64). Modules outlive a run under `next dev` and step retries, so the
 * smoke runner (#92) calls this at the start of each run.
 */
export function resetFakeCursors(): void {
  ocrCursor = 0;
  faceCursor = 0;
  resetRoboflowCursor();
}

function ocr(): string {
  const withText = allBubbles().filter((b) => b.ocrText);
  return withText[ocrCursor++ % withText.length]!.ocrText;
}

function context(prompt: string): string {
  const text = /\* \*\*Text:\*\* "([\s\S]*?)"\n/.exec(prompt)?.[1] ?? "";
  const bubbles = allBubbles();
  const b = bubbles.find((x) => x.ocrText === text);
  if (!b) {
    throw new Error(`DRY_RUN: no context fixture for "${text.slice(0, 80)}"`);
  }
  // gates: the first speech bubble on fixture page 1 gets an unknown speaker.
  const stranger = isGatesScenario() && b === bubbles[0];
  return `<scratchpad>DRY_RUN fixture ${b.legacyId}</scratchpad>\n${JSON.stringify(
    {
      type: b.type,
      speaker: stranger ? "Smoke Stranger" : b.speaker,
      emotion: b.emotion ?? "neutral",
      side: b.side ?? undefined,
      characterType: b.characterType ?? undefined,
      voiceDescription: b.voiceDescription ?? undefined,
    },
  )}`;
}

/**
 * The cue call (#437): the fixture bubble whose OCR text, whitespace
 * collapsed as `buildCuePrompt` collapses it, is the prompt's last `Input:`
 * line. Its `textWithCues`, else its OCR text.
 */
function cues(prompt: string): string {
  const inputs = [...prompt.matchAll(/^Input: (.*)$/gm)];
  const text = inputs.at(-1)?.[1] ?? "";
  const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
  const b = allBubbles().find((x) => collapse(x.ocrText) === text);
  if (!b) {
    throw new Error(`DRY_RUN: no cue fixture for "${text.slice(0, 80)}"`);
  }
  return b.textWithCues ?? b.ocrText;
}

function identifyFace(): string {
  const faces = loadIngestFixture().pages.flatMap((p) => p.faces);
  const n = faceCursor++;
  const face = faces[n % faces.length]!;
  // gates: the first face of the run comes back as a name the DB lacks.
  const name =
    isGatesScenario() && n === 0 ? "smoke-stranger" : face.characterName;
  return JSON.stringify({
    character_name: name,
    confidence: face.confidence,
    reasoning: "DRY_RUN fixture",
  });
}

/** Keeps the ids from the prompt, in the order the prompt lists them. */
function sortPlan(prompt: string): string {
  const panelIds = [...prompt.matchAll(/- panelId: (\S+)/g)].map((m) => m[1]!);
  const panels = panelIds.map((panelId, sortOrder) => ({
    panelId,
    sortOrder,
    bubbles: [] as Array<{ bubbleId: string; sortOrder: number }>,
  }));
  for (const m of prompt.matchAll(
    /bubbleId: (\S+)\n\s*assigned_panelId: (\S+)/g,
  )) {
    const panel = panels.find((p) => p.panelId === m[2]) ?? panels[0];
    panel?.bubbles.push({ bubbleId: m[1]!, sortOrder: panel.bubbles.length });
  }
  return JSON.stringify({ panels });
}

function voiceDescription(prompt: string): string {
  const name = /Character: "([^"]*)"/.exec(prompt)?.[1] ?? "";
  const key = name.toLowerCase().trim().replace(/\s+/g, "-");
  return (
    loadIngestFixture().voiceDescriptions[key] ??
    "A clear, friendly voice with a neutral American accent."
  );
}

/** Keyed on each prompt's fixed opening text. */
const MATCHERS: Array<{
  purpose: string;
  opening: string;
  respond: (prompt: string) => string;
}> = [
  {
    purpose: "ocr",
    opening: "Extract all text from this comic book speech bubble.",
    respond: ocr,
  },
  {
    purpose: "context",
    opening: "I am providing a full comic book page.",
    respond: context,
  },
  {
    purpose: "cues",
    opening: "You add ElevenLabs audio tags to one line of comic book dialogue",
    respond: cues,
  },
  {
    purpose: "face-id",
    opening: "You are identifying a character in a comic book panel.",
    respond: identifyFace,
  },
  {
    purpose: "sort",
    opening: "You are analyzing a comic book page image.",
    respond: sortPlan,
  },
  {
    purpose: "voice-description",
    opening: "Consolidate these voice description snippets",
    respond: voiceDescription,
  },
];

async function generateContent(params: { model: string; contents: unknown }) {
  const texts = textParts(params.contents);
  for (const m of MATCHERS) {
    const prompt = texts.find((t) => t.startsWith(m.opening));
    if (prompt === undefined) continue;
    logSpend("gemini", "request", 1, `(${m.purpose}, ${params.model})`);
    return { text: m.respond(prompt) };
  }
  const first = texts.join(" ").slice(0, 80);
  throw new Error(`DRY_RUN: no Gemini fixture for "${first}"`);
}

/** Deterministic unit vector seeded from a hash of the input. */
async function embedContent(params: { model: string; contents: unknown }) {
  logSpend("gemini", "embedding", 1, `(${params.model})`);
  const seed = createHash("sha256")
    .update(JSON.stringify(params.contents))
    .digest();
  let state = seed.readUInt32LE(0);
  // mulberry32
  const values = Array.from({ length: EMBEDDING_DIMENSIONS }, () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  });
  const norm = Math.hypot(...values) || 1;
  return { embeddings: [{ values: values.map((v) => v / norm) }] };
}

const fake = { models: { generateContent, embedContent } };

/**
 * `GoogleGenAI`-shaped fake. Only `models.generateContent` and
 * `models.embedContent` exist; anything else fails loudly at runtime.
 */
export function getFakeGeminiClient(): GoogleGenAI {
  return fake as unknown as GoogleGenAI;
}

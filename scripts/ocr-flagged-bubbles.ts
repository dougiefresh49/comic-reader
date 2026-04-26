#!/usr/bin/env node

/**
 * Run Gemini OCR + voice cue generation on bubbles marked needsOcr=true.
 *
 * These are typically bubbles added manually via the review UI where the user
 * placed the bounding box but left ocr_text empty. This script:
 *   1. Finds all bubbles with needsOcr=true in bubbles.json
 *   2. Crops each bubble region from the source page JPEG
 *   3. Sends the crop to Gemini to read the text and generate textWithCues
 *   4. Writes ocr_text + textWithCues back into bubbles.json
 *   5. Sets needsAudio=true and clears needsOcr
 *
 * Usage: pnpm ocr-flagged-bubbles -- --book <name> --issue <n>
 */

import fs from "fs-extra";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  GoogleGenAI,
  createPartFromBase64,
  createPartFromText,
} from "@google/genai";
import sharp from "sharp";
import { env } from "~/env.mjs";
import { GEMINI_MEDIUM } from "./utils/models.js";
import { cropImage } from "./utils/image-crop.js";
import type { Bubble } from "./utils/gemini-context.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

type BubblesCache = Record<
  string,
  (Bubble & { style?: Record<string, string> })[]
>;

function parseArgs(): { book: string; issue: string } {
  const args = process.argv.slice(2);
  let book = process.env.COMIC_BOOK ?? "";
  let issue = process.env.COMIC_ISSUE ?? "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg.startsWith("--book=")) book = arg.split("=")[1]?.trim() ?? book;
    if (arg === "--book") {
      const next = args[i + 1];
      if (next) book = next.trim();
    }
    if (arg.startsWith("--issue=")) {
      const v = arg.split("=")[1]?.trim();
      if (v) issue = v.startsWith("issue-") ? v : `issue-${v}`;
    }
    if (arg === "--issue") {
      const next = args[i + 1];
      if (next) issue = next.startsWith("issue-") ? next : `issue-${next}`;
    }
  }

  if (!book) {
    console.error("❌ --book is required");
    process.exit(1);
  }
  if (!issue) {
    console.error("❌ --issue is required");
    process.exit(1);
  }

  return { book, issue };
}

function styleToBox(
  style: Record<string, string>,
  imgWidth: number,
  imgHeight: number,
): { x: number; y: number; width: number; height: number } {
  const pct = (s: string) => parseFloat(s) / 100;
  return {
    x: Math.floor(pct(style.left ?? "0") * imgWidth),
    y: Math.floor(pct(style.top ?? "0") * imgHeight),
    width: Math.max(1, Math.floor(pct(style.width ?? "10") * imgWidth)),
    height: Math.max(1, Math.floor(pct(style.height ?? "5") * imgHeight)),
  };
}

async function ocrAndCue(
  gemini: GoogleGenAI,
  croppedBuffer: Buffer,
  bubble: Bubble,
): Promise<{ ocr_text: string; textWithCues: string }> {
  const base64 = croppedBuffer.toString("base64");
  const imagePart = createPartFromBase64(base64, "image/jpeg");

  const lines = [
    `Type: ${bubble.type ?? "SPEECH"}`,
    bubble.speaker ? `Speaker: ${bubble.speaker}` : null,
    bubble.emotion ? `Emotion: ${bubble.emotion}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const textPart = createPartFromText(
    `Read this comic book speech bubble and generate voice acting guidance.\n\n${lines}\n\nReturn ONLY a JSON object with:\n{\n  "ocr_text": "exact text transcribed from the bubble",\n  "textWithCues": "text rewritten with ElevenLabs voice cues in brackets (e.g. [Shouting], [whispering], [laughs], [sighs], [sarcastically])"\n}`,
  );

  const response = await gemini.models.generateContent({
    model: GEMINI_MEDIUM,
    contents: [imagePart, textPart],
  });

  const raw = response.text?.trim() ?? "";
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`No JSON in Gemini response: ${raw}`);

  const parsed = JSON.parse(jsonMatch[0]) as {
    ocr_text?: string;
    textWithCues?: string;
  };

  const ocr_text = parsed.ocr_text?.trim() ?? "";
  const textWithCues = parsed.textWithCues?.trim() || ocr_text;
  return { ocr_text, textWithCues };
}

async function main() {
  const { book, issue } = parseArgs();

  const ISSUE_DIR = join(PROJECT_ROOT, "assets", "comics", book, issue);
  const PAGES_DIR = join(ISSUE_DIR, "pages");
  const BUBBLES_PATH = join(ISSUE_DIR, "bubbles.json");
  const SEP = "─".repeat(60);

  if (!(await fs.pathExists(BUBBLES_PATH))) {
    console.error(`❌ Not found: ${BUBBLES_PATH}`);
    process.exit(1);
  }

  const cache = (await fs.readJson(BUBBLES_PATH)) as BubblesCache;

  // Collect flagged bubbles grouped by page
  const flagged: Array<{
    pageKey: string;
    bubble: BubblesCache[string][number];
  }> = [];
  for (const [pageKey, bubbles] of Object.entries(cache)) {
    for (const bubble of bubbles) {
      if (bubble.needsOcr) flagged.push({ pageKey, bubble });
    }
  }

  console.log(`\n${SEP}`);
  console.log(`  OCR flagged bubbles — ${book} / ${issue}`);
  console.log(`  ${flagged.length} bubble(s) marked needsOcr`);
  console.log(SEP);

  if (flagged.length === 0) {
    console.log("\n  Nothing to do.\n");
    return;
  }

  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("❌ GEMINI_API_KEY not set");
    process.exit(1);
  }
  const gemini = new GoogleGenAI({ apiKey });

  let processed = 0;
  let errors = 0;

  for (const { pageKey, bubble } of flagged) {
    const pageNum = pageKey.replace(".jpg", "");
    const pagePath = join(PAGES_DIR, pageKey);

    console.log(`\n  ${pageNum} / ${bubble.id}`);

    if (!(await fs.pathExists(pagePath))) {
      console.warn(`  ⚠️  Page image not found: ${pagePath} — skipping`);
      errors++;
      continue;
    }

    if (!bubble.style) {
      console.warn(`  ⚠️  No style bounds on bubble — skipping`);
      errors++;
      continue;
    }

    try {
      const imageBuffer = await fs.readFile(pagePath);
      const meta = await sharp(imageBuffer).metadata();
      const imgWidth = meta.width ?? 0;
      const imgHeight = meta.height ?? 0;

      const box = styleToBox(bubble.style, imgWidth, imgHeight);
      const cropped = await cropImage(imageBuffer, box);

      const { ocr_text, textWithCues } = await ocrAndCue(
        gemini,
        cropped,
        bubble,
      );

      bubble.ocr_text = ocr_text;
      bubble.textWithCues = textWithCues;
      bubble.needsAudio = true;
      delete bubble.needsOcr;

      console.log(
        `  ✓ "${ocr_text.slice(0, 60)}${ocr_text.length > 60 ? "…" : ""}"`,
      );
      console.log(
        `    cues: "${textWithCues.slice(0, 60)}${textWithCues.length > 60 ? "…" : ""}"`,
      );

      processed++;

      // Write after each bubble so partial progress survives a crash
      await fs.writeJson(BUBBLES_PATH, cache, { spaces: 2 });
    } catch (err) {
      console.error(`  ❌ ${err instanceof Error ? err.message : String(err)}`);
      errors++;
    }
  }

  console.log(`\n${SEP}`);
  console.log(`  Done. Processed: ${processed}   Errors: ${errors}`);
  console.log(`  bubbles.json updated.`);
  console.log(SEP);
}

main().catch((err) => {
  console.error("❌ Fatal:", err);
  process.exit(1);
});

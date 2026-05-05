#!/usr/bin/env node

/**
 * Pipeline step: sort-page-elements
 *
 * One Gemini (GEMINI_MEDIUM) vision call per page: determines reading order for
 * comic panels and for speech bubbles within each panel. Updates `panels.sort_order`
 * and `bubbles.sort_order` in Supabase.
 *
 * Usage:
 *   pnpm sort-page-elements -- --book tmnt-mmpr-iii --issue 1 [--auto]
 */

import fs from "fs-extra";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { glob } from "glob";
import sharp from "sharp";
import {
  GoogleGenAI,
  createPartFromBase64,
  createPartFromText,
} from "@google/genai";
import { GEMINI_MEDIUM } from "./utils/models.js";
import { supabase } from "./lib/supabase.js";
import { env } from "~/env.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

type BoundingBoxJson = { x: number; y: number; w: number; h: number };

interface PanelRow {
  id: string;
  panel_id: string;
  page_number: number;
  sort_order: number;
  bounding_box: BoundingBoxJson;
}

interface BubbleRow {
  id: string;
  legacy_id: string | null;
  panel_id: string | null;
  sort_order: number;
  ocr_text: string | null;
  text_with_cues: string | null;
  ignored: boolean;
  box_2d: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  } | null;
  style: Record<string, string> | null;
}

interface GeminiPanelSortEntry {
  panelId: string;
  sortOrder: number;
  bubbles: Array<{ bubbleId: string; sortOrder: number }>;
}

interface GeminiSortResponse {
  panels: GeminiPanelSortEntry[];
}

function parseArgs(): {
  book: string;
  issue: string;
  auto: boolean;
  apiKeyName: "GEMINI_API_KEY" | "GEMINI_API_KEY_2";
} {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage: pnpm sort-page-elements -- --book <name> --issue <n> [options]

Options:
  --book NAME, --book=NAME       Book ID (or COMIC_BOOK env var)
  --issue N, --issue=N           Issue folder id e.g. issue-1 (or COMIC_ISSUE)
  --auto                         Faster batch (no delay between pages); for CI / ingest-worker
  --api-key KEY                   GEMINI_API_KEY | GEMINI_API_KEY_2 (default: GEMINI_API_KEY)
  --help, -h                     Show this help
`);
    process.exit(0);
  }

  let book = process.env.COMIC_BOOK ?? "";
  let issue = process.env.COMIC_ISSUE ?? "";
  let auto = false;
  let apiKeyName: "GEMINI_API_KEY" | "GEMINI_API_KEY_2" = "GEMINI_API_KEY";

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
      if (next) {
        const n = next.trim();
        issue = n.startsWith("issue-") ? n : `issue-${n}`;
      }
    }
    if (arg === "--auto") auto = true;
    if (arg.startsWith("--api-key=")) {
      const keyName = arg.split("=")[1]?.trim();
      if (keyName === "GEMINI_API_KEY" || keyName === "GEMINI_API_KEY_2") {
        apiKeyName = keyName;
      }
    }
    if (arg === "--api-key") {
      const next = args[i + 1];
      if (
        next &&
        (next === "GEMINI_API_KEY" || next === "GEMINI_API_KEY_2")
      ) {
        apiKeyName = next;
      }
    }
  }

  if (!book || !issue) {
    console.error(
      "❌ --book and --issue are required (or set COMIC_BOOK / COMIC_ISSUE)",
    );
    process.exit(1);
  }

  return { book, issue, auto, apiKeyName };
}

async function discoverPageNumbers(issueDir: string): Promise<number[]> {
  const pagesWebpDir = join(issueDir, "pages-webp");
  const files = await glob("page-*.webp", { cwd: pagesWebpDir });
  const numbers = files
    .map((f) => {
      const m = /page-(\d+)\.webp$/.exec(f);
      return m?.[1] ? parseInt(m[1], 10) : null;
    })
    .filter((n): n is number => typeof n === "number")
    .sort((a, b) => a - b);
  return numbers;
}

function extractJsonObject(text: string): string {
  let jsonText = text.trim();
  const jsonMatch = jsonText.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch?.[1]) {
    jsonText = jsonMatch[1].trim();
  } else {
    const codeMatch = jsonText.match(/```\s*([\s\S]*?)\s*```/);
    if (codeMatch?.[1]) jsonText = codeMatch[1].trim();
  }
  const objectMatch = jsonText.match(/\{[\s\S]*\}/);
  return objectMatch?.[0] ?? jsonText;
}

function bubbleSnippet(b: BubbleRow): string {
  const t = (b.text_with_cues ?? b.ocr_text ?? "").trim();
  return t.length > 120 ? `${t.slice(0, 117)}...` : t;
}

function bubbleLayoutLine(
  b: BubbleRow,
  imgW: number,
  imgH: number,
): string {
  let x = b.box_2d?.x ?? 0;
  let y = b.box_2d?.y ?? 0;
  let w = b.box_2d?.width ?? 0;
  let h = b.box_2d?.height ?? 0;
  if (
    x === 0 &&
    y === 0 &&
    w === 0 &&
    h === 0 &&
    b.style &&
    imgW > 0 &&
    imgH > 0
  ) {
    const pct = (s: string | undefined) => parseFloat(s ?? "0") / 100;
    x = Math.floor(pct(b.style.left) * imgW);
    y = Math.floor(pct(b.style.top) * imgH);
    w = Math.max(1, Math.floor(pct(b.style.width) * imgW));
    h = Math.max(1, Math.floor(pct(b.style.height) * imgH));
  }
  const nx = imgW > 0 ? x / imgW : 0;
  const ny = imgH > 0 ? y / imgH : 0;
  const nw = imgW > 0 ? w / imgW : 0;
  const nh = imgH > 0 ? h / imgH : 0;
  const panelHint = b.panel_id ?? "none";
  return `- bubbleId: ${b.id}\n  assigned_panel_uuid: ${panelHint}\n  bbox_normalized: x=${nx.toFixed(4)}, y=${ny.toFixed(4)}, w=${nw.toFixed(4)}, h=${nh.toFixed(4)}\n  text: "${bubbleSnippet(b).replace(/"/g, '\\"')}"\n  ignored: ${b.ignored}`;
}

async function getSortPlanFromGemini(
  gemini: GoogleGenAI,
  pageImage: Buffer,
  imgW: number,
  imgH: number,
  panels: PanelRow[],
  bubbles: BubbleRow[],
): Promise<GeminiSortResponse> {
  const panelLines = panels
    .map((p) => {
      const bb = p.bounding_box;
      return `- panelId (uuid): ${p.id}\n  human_panel_id: ${p.panel_id}\n  current_sort_order: ${p.sort_order}\n  bbox_normalized: x=${bb.x}, y=${bb.y}, w=${bb.w}, h=${bb.h}`;
    })
    .join("\n");

  const bubbleLines = bubbles.map((b) => bubbleLayoutLine(b, imgW, imgH));

  const prompt = `You are analyzing a comic book page image.

**Task:** Determine:
1. The correct READING ORDER of **panels** on this page (Western comics: mostly top-to-bottom rows, left-to-right within a row; manga may use right-to-left columns — follow what the layout implies).
2. Within EACH panel, the correct reading order of **speech bubbles / captions** (follow tails, narrative flow, and spatial cues).

**Panel records (bbox x,y,w,h are fractions of page width/height, origin top-left):**
${panelLines || "(no panels)"}

**Bubble records:**
${bubbleLines.join("\n") || "(no bubbles)"}

**Rules:**
- Use each panel's **panelId** exactly as given — it is the database UUID string.
- Use each bubble's **bubbleId** exactly as given — it is the database UUID string.
- Include EVERY panel id exactly once in your output.
- Include EVERY bubble id exactly once inside the \`bubbles\` array of exactly one panel (the panel where the bubble visually belongs). If unsure, pick the panel whose bbox contains the bubble center.
- Bubbles with ignored=true should still be listed in reading order (they remain in the narrative layout).

**Output — JSON only (no markdown fences):**
{
  "panels": [
    {
      "panelId": "<panel uuid>",
      "sortOrder": 0,
      "bubbles": [
        { "bubbleId": "<bubble uuid>", "sortOrder": 0 }
      ]
    }
  ]
}

- \`panels[].sortOrder\`: 0-based order for panels across the page.
- \`bubbles[].sortOrder\`: 0-based order within that panel only.
`;

  const imagePart = createPartFromBase64(
    pageImage.toString("base64"),
    "image/webp",
  );
  const textPart = createPartFromText(prompt);

  const response = await gemini.models.generateContent({
    model: GEMINI_MEDIUM,
    contents: [imagePart, textPart],
  });

  const text = response.text;
  if (!text) throw new Error("No text response from Gemini");

  const jsonText = extractJsonObject(text);
  const parsed = JSON.parse(jsonText) as GeminiSortResponse;
  if (!parsed.panels || !Array.isArray(parsed.panels)) {
    throw new Error("Invalid response: missing panels array");
  }
  return parsed;
}

function validateAndFlattenOrders(
  panels: PanelRow[],
  bubbles: BubbleRow[],
  result: GeminiSortResponse,
): {
  panelOrders: Map<string, number>;
  bubbleGlobalOrder: Map<string, number>;
} {
  const panelIds = new Set(panels.map((p) => p.id));
  const bubbleIds = new Set(bubbles.map((b) => b.id));

  const seenPanels = new Set<string>();
  const seenBubbles = new Set<string>();

  const panelOrders = new Map<string, number>();
  for (const entry of result.panels) {
    if (!panelIds.has(entry.panelId)) {
      throw new Error(`Unknown panelId in response: ${entry.panelId}`);
    }
    if (seenPanels.has(entry.panelId)) {
      throw new Error(`Duplicate panelId in response: ${entry.panelId}`);
    }
    seenPanels.add(entry.panelId);
    for (const b of entry.bubbles ?? []) {
      if (!bubbleIds.has(b.bubbleId)) {
        throw new Error(`Unknown bubbleId in response: ${b.bubbleId}`);
      }
      if (seenBubbles.has(b.bubbleId)) {
        throw new Error(`Duplicate bubbleId in response: ${b.bubbleId}`);
      }
      seenBubbles.add(b.bubbleId);
    }
  }

  if (seenPanels.size !== panelIds.size) {
    const missing = [...panelIds].filter((id) => !seenPanels.has(id));
    throw new Error(`Missing panels in response: ${missing.join(", ")}`);
  }
  if (seenBubbles.size !== bubbleIds.size) {
    const missing = [...bubbleIds].filter((id) => !seenBubbles.has(id));
    throw new Error(`Missing bubbles in response: ${missing.join(", ")}`);
  }

  const sortedPanels = [...result.panels].sort(
    (a, b) => a.sortOrder - b.sortOrder,
  );
  sortedPanels.forEach((p, idx) => panelOrders.set(p.panelId, idx));

  const bubbleGlobalOrder = new Map<string, number>();
  let globalIdx = 0;
  for (const p of sortedPanels) {
    const sortedBubbles = [...(p.bubbles ?? [])].sort(
      (a, b) => a.sortOrder - b.sortOrder,
    );
    for (const b of sortedBubbles) {
      bubbleGlobalOrder.set(b.bubbleId, globalIdx++);
    }
  }

  return { panelOrders, bubbleGlobalOrder };
}

/** Top-to-bottom rows, left-to-right within row (pixel coords). */
function sortBubbleRowsHeuristic(
  bubbles: BubbleRow[],
  imgW: number,
  imgH: number,
): string[] {
  const ROW_TOLERANCE = 50;
  const positioned = bubbles.map((b) => {
    let x = b.box_2d?.x ?? 0;
    let y = b.box_2d?.y ?? 0;
    if (
      x === 0 &&
      y === 0 &&
      b.style &&
      imgW > 0 &&
      imgH > 0
    ) {
      const pct = (s: string | undefined) => parseFloat(s ?? "0") / 100;
      x = Math.floor(pct(b.style.left) * imgW);
      y = Math.floor(pct(b.style.top) * imgH);
    }
    return { id: b.id, x, y };
  });
  return [...positioned]
    .sort((a, b) => {
      if (Math.abs(a.y - b.y) < ROW_TOLERANCE) return a.x - b.x;
      return a.y - b.y;
    })
    .map((p) => p.id);
}

async function main() {
  const { book, issue, auto, apiKeyName } = parseArgs();

  const ISSUE_DIR = join(PROJECT_ROOT, "assets", "comics", book, issue);
  const pagesWebpDir = join(ISSUE_DIR, "pages-webp");

  if (!(await fs.pathExists(ISSUE_DIR))) {
    console.error(`❌ Issue dir not found: ${ISSUE_DIR}`);
    process.exit(1);
  }

  const apiKey = env[apiKeyName];
  if (!apiKey) {
    console.error(`❌ ${apiKeyName} not set in environment`);
    process.exit(1);
  }

  const gemini = new GoogleGenAI({ apiKey });

  const pageNumbers = await discoverPageNumbers(ISSUE_DIR);
  if (pageNumbers.length === 0) {
    console.error(
      `❌ No page-*.webp in ${pagesWebpDir} — run convert-pages-to-webp first.`,
    );
    process.exit(1);
  }

  console.log(
    `\n🔀 sort-page-elements — ${book} / ${issue} (${pageNumbers.length} pages${auto ? ", --auto" : ""})\n`,
  );

  let ok = 0;
  let failed = 0;

  for (let i = 0; i < pageNumbers.length; i++) {
    const pageNum = pageNumbers[i]!;
    const padded = String(pageNum).padStart(2, "0");
    const imagePath = join(pagesWebpDir, `page-${padded}.webp`);

    if (!(await fs.pathExists(imagePath))) {
      console.log(`   ⚠ page-${padded}: missing WebP — skip`);
      failed++;
      continue;
    }

    const { data: panelRows, error: pErr } = await supabase
      .from("panels")
      .select("id, panel_id, page_number, sort_order, bounding_box")
      .eq("book_id", book)
      .eq("issue_id", issue)
      .eq("page_number", pageNum);

    if (pErr) {
      console.error(`   ❌ page-${padded}: panels query: ${pErr.message}`);
      failed++;
      continue;
    }

    const { data: bubbleRows, error: bErr } = await supabase
      .from("bubbles")
      .select(
        "id, legacy_id, panel_id, sort_order, ocr_text, text_with_cues, ignored, box_2d, style",
      )
      .eq("book_id", book)
      .eq("issue_id", issue)
      .eq("page_number", pageNum);

    if (bErr) {
      console.error(`   ❌ page-${padded}: bubbles query: ${bErr.message}`);
      failed++;
      continue;
    }

    const panels = (panelRows ?? []) as PanelRow[];
    const bubbles = (bubbleRows ?? []) as BubbleRow[];

    if (panels.length === 0 && bubbles.length === 0) {
      console.log(`   ⏭ page-${padded}: no panels or bubbles in DB — skip`);
      continue;
    }

    try {
      const pageImage = await fs.readFile(imagePath);
      const meta = await sharp(pageImage).metadata();
      const imgW = meta.width ?? 0;
      const imgH = meta.height ?? 0;

      if (panels.length === 0 && bubbles.length > 0) {
        const orderedIds = sortBubbleRowsHeuristic(bubbles, imgW, imgH);
        const bubbleGlobalOrder = new Map<string, number>();
        orderedIds.forEach((id, idx) => bubbleGlobalOrder.set(id, idx));
        const bubbleUpdates = [...bubbleGlobalOrder.entries()].map(
          ([id, sort_order]) =>
            supabase.from("bubbles").update({ sort_order }).eq("id", id),
        );
        const results = await Promise.all(bubbleUpdates);
        const errResult = results.find((r) => r.error);
        if (errResult?.error) throw new Error(errResult.error.message);
        console.log(
          `   ✓ page-${padded}: 0 panels — heuristic bubble sort (${bubbles.length})`,
        );
        ok++;
        if (!auto && i < pageNumbers.length - 1) {
          await new Promise((r) => setTimeout(r, 2000));
        }
        continue;
      }

      const plan = await getSortPlanFromGemini(
        gemini,
        pageImage,
        imgW,
        imgH,
        panels,
        bubbles,
      );
      const { panelOrders, bubbleGlobalOrder } = validateAndFlattenOrders(
        panels,
        bubbles,
        plan,
      );

      const panelUpdates = [...panelOrders.entries()].map(
        ([id, sort_order]) =>
          supabase.from("panels").update({ sort_order }).eq("id", id),
      );
      const bubbleUpdates = [...bubbleGlobalOrder.entries()].map(
        ([id, sort_order]) =>
          supabase.from("bubbles").update({ sort_order }).eq("id", id),
      );

      const results = await Promise.all([...panelUpdates, ...bubbleUpdates]);
      const errResult = results.find((r) => r.error);
      if (errResult?.error) {
        throw new Error(errResult.error.message);
      }

      console.log(
        `   ✓ page-${padded}: ${panels.length} panel(s), ${bubbles.length} bubble(s)`,
      );
      ok++;
    } catch (e) {
      console.error(
        `   ❌ page-${padded}: ${e instanceof Error ? e.message : String(e)}`,
      );
      failed++;
    }

    if (!auto && i < pageNumbers.length - 1) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  console.log(`\n✅ Done. Updated: ${ok} page(s). Failed/skipped: ${failed}.\n`);
}

main().catch((err) => {
  console.error("❌ sort-page-elements:", err);
  process.exit(1);
});

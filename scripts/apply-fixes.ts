#!/usr/bin/env node

/**
 * Apply corrections exported from the web review interface to bubbles.json.
 *
 * Reads fixes.json (default: ./fixes.json), applies each fix to the matching
 * bubbles.json in assets/comics/<bookId>/<issueId>/bubbles.json, and writes
 * the updated file back to disk.
 *
 * Usage: pnpm apply-fixes [--fixes=<path>] [--dry-run]
 */

import fs from "fs-extra";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

interface BubbleStyle {
  left: string;
  top: string;
  width: string;
  height: string;
}

interface Bubble {
  id: string;
  box_2d: Record<string, unknown>;
  ocr_text: string;
  type: "SPEECH" | "NARRATION" | "CAPTION" | "SFX" | "BACKGROUND";
  speaker: string | null;
  emotion: string;
  textWithCues?: string;
  aiReasoning?: string;
  ignored?: boolean;
  needsAudio?: boolean;
  needsOcr?: boolean;
  style?: BubbleStyle;
  [key: string]: unknown;
}

const AUDIO_AFFECTING_FIELDS = new Set<string>([
  "speaker",
  "ocr_text",
  "textWithCues",
  "type",
]);

type BubblesCache = Record<string, Bubble[]>;

interface FixBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

type FixChanges = Partial<
  Pick<
    Bubble,
    "speaker" | "emotion" | "ocr_text" | "type" | "textWithCues" | "ignored"
  >
> & { bounds?: FixBounds };

type FixEntry =
  | { bubbleId: string; action: "update"; changes: FixChanges }
  | { bubbleId: string; action: "delete" }
  | { bubbleId: string; action: "add"; pageIndex: number; data: FixChanges }
  | {
      bubbleId: "__page-reorder__";
      action: "reorder";
      pageIndex: number;
      orderedIds: string[];
    };

interface FixesJson {
  bookId: string;
  issueId: string;
  fixes: FixEntry[];
}

function parseArgs(): { fixesPath: string; dryRun: boolean } {
  const args = process.argv.slice(2);
  let fixesPath = join(process.cwd(), "fixes.json");
  let dryRun = false;

  for (const arg of args) {
    if (arg.startsWith("--fixes=")) fixesPath = arg.slice("--fixes=".length);
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: pnpm apply-fixes [--fixes=<path>] [--dry-run]\n\n" +
          "  --fixes=<path>  Path to fixes.json (default: ./fixes.json)\n" +
          "  --dry-run       Print changes without writing to disk",
      );
      process.exit(0);
    }
  }
  return { fixesPath, dryRun };
}

function boundsToStyle(bounds: FixBounds): BubbleStyle {
  return {
    left: `${(bounds.x * 100).toFixed(2)}%`,
    top: `${(bounds.y * 100).toFixed(2)}%`,
    width: `${(bounds.width * 100).toFixed(2)}%`,
    height: `${(bounds.height * 100).toFixed(2)}%`,
  };
}

function pageKeyFromIndex(pageIndex: number): string {
  return `page-${String(pageIndex).padStart(2, "0")}.jpg`;
}

function applyFix(cache: BubblesCache, fix: FixEntry): void {
  if (fix.action === "delete") {
    for (const [pageKey, bubbles] of Object.entries(cache)) {
      const idx = bubbles.findIndex((b) => b.id === fix.bubbleId);
      if (idx !== -1) {
        bubbles.splice(idx, 1);
        console.log(`  [delete] ${fix.bubbleId} removed from ${pageKey}`);
        return;
      }
    }
    console.warn(`  [delete] ${fix.bubbleId} not found — skipped`);
    return;
  }

  if (fix.action === "update") {
    for (const [pageKey, bubbles] of Object.entries(cache)) {
      const bubble = bubbles.find((b) => b.id === fix.bubbleId);
      if (bubble) {
        const { bounds, ...rest } = fix.changes;
        Object.assign(bubble, rest);
        if (bounds) bubble.style = boundsToStyle(bounds);
        const affectsAudio = Object.keys(fix.changes).some((k) =>
          AUDIO_AFFECTING_FIELDS.has(k),
        );
        if (affectsAudio && !bubble.ignored) bubble.needsAudio = true;
        console.log(
          `  [update] ${fix.bubbleId} on ${pageKey}: ${Object.keys(fix.changes).join(", ")}${affectsAudio ? " ⚡ needsAudio" : ""}`,
        );
        return;
      }
    }
    console.warn(`  [update] ${fix.bubbleId} not found — skipped`);
    return;
  }

  if (fix.action === "reorder") {
    const key = pageKeyFromIndex(fix.pageIndex);
    const original = cache[key] ?? [];
    const idToIndex = new Map(fix.orderedIds.map((id, i) => [id, i]));
    cache[key] = [...original].sort((a, b) => {
      const ai = idToIndex.get(a.id) ?? Infinity;
      const bi = idToIndex.get(b.id) ?? Infinity;
      return ai - bi;
    });
    console.log(
      `  [reorder] page ${fix.pageIndex}: ${fix.orderedIds.length} bubble(s) reordered`,
    );
    return;
  }

  if (fix.action === "add") {
    const key = pageKeyFromIndex(fix.pageIndex);
    if (!cache[key]) cache[key] = [];

    const { bounds, ...rest } = fix.data;
    const style = bounds ? boundsToStyle(bounds) : undefined;

    const hasText = !!(rest.ocr_text?.trim() || rest.textWithCues?.trim());
    const newBubble: Bubble = {
      id: fix.bubbleId,
      box_2d: {},
      ocr_text: rest.ocr_text ?? "",
      type: rest.type ?? "SPEECH",
      speaker: rest.speaker ?? null,
      emotion: rest.emotion ?? "",
      textWithCues: rest.textWithCues,
      needsAudio: true,
      needsOcr: !hasText ? true : undefined,
      style,
      ...rest,
    };

    // Remove synthetic fields that aren't Bubble fields
    delete newBubble.bounds;

    cache[key]!.push(newBubble);
    const flags = [!hasText ? "needsOcr" : null, "needsAudio"]
      .filter(Boolean)
      .join(", ");
    console.log(`  [add] ${fix.bubbleId} added to ${key} ⚡ ${flags}`);
    return;
  }
}

async function main() {
  const { fixesPath, dryRun } = parseArgs();

  if (!fs.existsSync(fixesPath)) {
    console.error(`fixes.json not found at: ${fixesPath}`);
    process.exit(1);
  }

  const fixesJson = (await fs.readJson(fixesPath)) as FixesJson;
  const { bookId, issueId, fixes } = fixesJson;

  if (!bookId || !issueId || !Array.isArray(fixes)) {
    console.error("Invalid fixes.json format.");
    process.exit(1);
  }

  const bubblesPath = join(
    PROJECT_ROOT,
    "assets",
    "comics",
    bookId,
    issueId,
    "bubbles.json",
  );

  if (!fs.existsSync(bubblesPath)) {
    console.error(`bubbles.json not found: ${bubblesPath}`);
    process.exit(1);
  }

  const cache = (await fs.readJson(bubblesPath)) as BubblesCache;

  console.log(
    `\nApplying ${fixes.length} fix(es) to ${bookId}/${issueId}...\n`,
  );

  for (const fix of fixes) {
    applyFix(cache, fix);
  }

  if (dryRun) {
    console.log("\n[dry-run] No changes written.");
  } else {
    await fs.writeJson(bubblesPath, cache, { spaces: 2 });
    console.log(`\nWrote updated bubbles.json → ${bubblesPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

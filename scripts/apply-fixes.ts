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
import { supabase } from "./lib/supabase.js";

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

function pageNumFromKey(key: string): number {
  const m = key.match(/page-?0*(\d+)/i);
  return m ? parseInt(m[1]!, 10) : 0;
}

function findBubbleInCache(
  cache: BubblesCache,
  bubbleId: string,
): Bubble | null {
  for (const bubbles of Object.values(cache)) {
    const b = bubbles.find((x) => x.id === bubbleId);
    if (b) return b;
  }
  return null;
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

    // Step 5 — sync changed bubbles to DB
    const changedUuids = new Set<string>();

    for (const fix of fixes) {
      if (fix.action === "update") {
        const { data: row, error: selErr } = await supabase
          .from("bubbles")
          .select("id")
          .eq("book_id", bookId)
          .eq("issue_id", issueId)
          .eq("legacy_id", fix.bubbleId)
          .maybeSingle();
        if (selErr) {
          console.warn(
            `  [db] update lookup ${fix.bubbleId}: ${selErr.message}`,
          );
          continue;
        }
        if (!row?.id) {
          console.warn(
            `  [db] update: no row for legacy_id ${fix.bubbleId} — skipped`,
          );
          continue;
        }
        const merged = findBubbleInCache(cache, fix.bubbleId);
        const { bounds, ...rest } = fix.changes;
        const patch: Record<string, unknown> = {};
        if (rest.speaker !== undefined) patch.speaker = rest.speaker;
        if (rest.ocr_text !== undefined) patch.ocr_text = rest.ocr_text;
        if (rest.textWithCues !== undefined) {
          patch.text_with_cues = rest.textWithCues;
        }
        if (rest.type !== undefined) patch.type = rest.type;
        if (rest.emotion !== undefined) patch.emotion = rest.emotion;
        if (rest.ignored !== undefined) patch.ignored = rest.ignored;
        if (bounds) patch.style = boundsToStyle(bounds);
        if (merged) {
          patch.needs_audio = merged.needsAudio ?? false;
          patch.needs_ocr = merged.needsOcr ?? false;
        }
        const { error: uErr } = await supabase
          .from("bubbles")
          .update(patch)
          .eq("id", row.id);
        if (uErr) console.warn(`  [db] update: ${uErr.message}`);
        else {
          changedUuids.add(row.id);
          console.log(`  [db] updated row ${row.id} (${fix.bubbleId})`);
        }
        continue;
      }

      if (fix.action === "delete") {
        const { data: row, error: selErr } = await supabase
          .from("bubbles")
          .select("id")
          .eq("book_id", bookId)
          .eq("issue_id", issueId)
          .eq("legacy_id", fix.bubbleId)
          .maybeSingle();
        if (selErr) {
          console.warn(
            `  [db] delete lookup ${fix.bubbleId}: ${selErr.message}`,
          );
          continue;
        }
        if (!row?.id) {
          console.warn(
            `  [db] delete: no row for legacy_id ${fix.bubbleId} — skipped`,
          );
          continue;
        }
        const { error: dErr } = await supabase
          .from("bubbles")
          .delete()
          .eq("id", row.id);
        if (dErr) console.warn(`  [db] delete: ${dErr.message}`);
        else {
          changedUuids.add(row.id);
          console.log(`  [db] deleted row ${row.id} (${fix.bubbleId})`);
        }
        continue;
      }

      if (fix.action === "add") {
        const pageKey = pageKeyFromIndex(fix.pageIndex);
        const bubble = findBubbleInCache(cache, fix.bubbleId);
        if (!bubble) {
          console.warn(
            `  [db] add: bubble ${fix.bubbleId} not in cache — skipped`,
          );
          continue;
        }
        const list = cache[pageKey] ?? [];
        const sortIndex = list.findIndex((b) => b.id === fix.bubbleId);
        const pageNumber = pageNumFromKey(pageKey);
        const charT = (bubble as Record<string, unknown>).characterType;
        const vDesc = (bubble as Record<string, unknown>).voiceDescription;
        const { error: iErr, data: ins } = await supabase
          .from("bubbles")
          .insert({
            legacy_id: fix.bubbleId,
            book_id: bookId,
            issue_id: issueId,
            page_number: pageNumber,
            sort_order: sortIndex >= 0 ? sortIndex : 0,
            ocr_text: bubble.ocr_text ?? null,
            text_with_cues: bubble.textWithCues ?? null,
            type: bubble.type ?? "SPEECH",
            speaker: bubble.speaker ?? null,
            emotion: bubble.emotion ?? null,
            character_type: typeof charT === "string" ? charT : null,
            side:
              typeof (bubble as Record<string, unknown>).side === "string"
                ? ((bubble as Record<string, unknown>).side as string)
                : null,
            voice_description: typeof vDesc === "string" ? vDesc : null,
            ai_reasoning: bubble.aiReasoning ?? null,
            ignored: bubble.ignored ?? false,
            needs_audio: bubble.needsAudio ?? false,
            needs_ocr: bubble.needsOcr ?? false,
            box_2d: bubble.box_2d ?? null,
            style: bubble.style ?? null,
            audio_storage_path: `${fix.bubbleId}.mp3`,
          })
          .select("id")
          .single();
        if (iErr) console.warn(`  [db] insert: ${iErr.message}`);
        else if (ins?.id) {
          changedUuids.add(ins.id);
          console.log(`  [db] inserted row ${ins.id} (${fix.bubbleId})`);
        }
        continue;
      }

      if (fix.action === "reorder" && fix.bubbleId === "__page-reorder__") {
        for (let i = 0; i < fix.orderedIds.length; i++) {
          const legacyId = fix.orderedIds[i]!;
          const { data: row, error: oErr } = await supabase
            .from("bubbles")
            .select("id")
            .eq("book_id", bookId)
            .eq("issue_id", issueId)
            .eq("legacy_id", legacyId)
            .maybeSingle();
          if (oErr) {
            console.warn(`  [db] reorder lookup ${legacyId}: ${oErr.message}`);
            continue;
          }
          if (!row?.id) {
            console.warn(`  [db] reorder: no row for ${legacyId} — skipped`);
            continue;
          }
          const { error: rErr } = await supabase
            .from("bubbles")
            .update({ sort_order: i })
            .eq("id", row.id);
          if (rErr) {
            console.warn(`  [db] reorder ${legacyId}: ${rErr.message}`);
          } else {
            changedUuids.add(row.id);
            console.log(
              `  [db] reordered ${legacyId} → sort_order ${i} (${row.id})`,
            );
          }
        }
      }
    }

    if (changedUuids.size > 0) {
      console.log(
        `\n✓ DB sync: ${changedUuids.size} bubble(s) — UUIDs: ${[...changedUuids].join(", ")}`,
      );
    } else {
      console.log("\n✓ DB sync: no rows affected");
    }

    // Step 6 — ISR revalidation
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL;
    const secret = process.env.REVALIDATE_SECRET;
    if (baseUrl && secret) {
      const res = await fetch(`${baseUrl}/api/revalidate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-revalidate-secret": secret,
        },
        body: JSON.stringify({ bookId, issueId }),
      });
      if (!res.ok) {
        console.warn(`  [revalidate] ${res.status} ${await res.text()}`);
      } else {
        console.log("\n✓ ISR cache revalidated");
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

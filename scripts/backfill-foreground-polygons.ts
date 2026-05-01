#!/usr/bin/env node

/**
 * Backfill panels.foreground_polygons from local foreground sidecars.
 *
 * For each issue under assets/comics/<book>/<issue>/data/foreground/,
 * read the per-page sidecar and join its panels to DB panels rows by
 * matching panel_bbox_page against panels.bounding_box (highest IoU).
 *
 * Idempotent: --overwrite re-writes panels that already have a value.
 *
 * Usage:
 *   pnpm backfill-foreground-polygons -- --book tmnt-mmpr-iii --issue 1
 *   pnpm backfill-foreground-polygons -- --book ... --issue ... --overwrite
 *   pnpm backfill-foreground-polygons -- --book ... --issue ... --dry-run
 */

import fs from "fs-extra";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { glob } from "glob";
import { supabase } from "./lib/supabase.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

interface Args {
  book: string;
  issue: string;
  overwrite: boolean;
  dryRun: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      "Usage: pnpm backfill-foreground-polygons -- --book <name> --issue <n> [--overwrite] [--dry-run]",
    );
    process.exit(0);
  }
  let book = process.env.COMIC_BOOK ?? "";
  let issue = process.env.COMIC_ISSUE ?? "";
  let overwrite = false;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a.startsWith("--book=")) book = a.split("=")[1]?.trim() ?? book;
    else if (a === "--book") book = argv[i + 1]?.trim() ?? book;
    else if (a.startsWith("--issue=")) {
      const v = a.split("=")[1]?.trim() ?? "";
      issue = v.startsWith("issue-") ? v : `issue-${v}`;
    } else if (a === "--issue") {
      const v = argv[i + 1]?.trim() ?? "";
      issue = v.startsWith("issue-") ? v : `issue-${v}`;
    } else if (a === "--overwrite") overwrite = true;
    else if (a === "--dry-run") dryRun = true;
  }
  if (!book || !issue) {
    console.error("❌ --book and --issue required");
    process.exit(1);
  }
  return { book, issue, overwrite, dryRun };
}

interface BoxFrac {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PointFrac {
  x: number;
  y: number;
}

interface SidecarPanel {
  panel_index: number;
  panel_bbox_page: BoxFrac;
  foreground_polygons: {
    characters: PointFrac[][];
    bubbles: PointFrac[][];
  };
}

interface ForegroundSidecar {
  image: { width: number; height: number };
  panels: SidecarPanel[];
}

interface DBPanel {
  id: string;
  panel_id: string;
  page_number: number;
  sort_order: number;
  bounding_box: BoxFrac;
  foreground_polygons: unknown;
}

function iou(a: BoxFrac, b: BoxFrac): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

interface MatchPlan {
  dbPanelId: string;
  panelLabel: string;
  iou: number;
  payload: SidecarPanel["foreground_polygons"];
  alreadyHasValue: boolean;
}

interface PageMatchResult {
  pageNumber: number;
  matched: MatchPlan[];
  unmatchedSidecar: number;
  unmatchedDb: number;
}

function matchPage(
  pageNumber: number,
  sidecar: ForegroundSidecar,
  dbPanels: DBPanel[],
  iouThreshold: number,
): PageMatchResult {
  // Greedy IoU matching: for each sidecar panel, take the best
  // available DB panel above the threshold.
  const matched: MatchPlan[] = [];
  const usedDbIds = new Set<string>();

  for (const sidePanel of sidecar.panels) {
    let best: { db: DBPanel; iou: number } | null = null;
    for (const db of dbPanels) {
      if (usedDbIds.has(db.id)) continue;
      const score = iou(sidePanel.panel_bbox_page, db.bounding_box);
      if (!best || score > best.iou) best = { db, iou: score };
    }
    if (!best || best.iou < iouThreshold) continue;
    usedDbIds.add(best.db.id);
    matched.push({
      dbPanelId: best.db.id,
      panelLabel: best.db.panel_id,
      iou: best.iou,
      payload: sidePanel.foreground_polygons,
      alreadyHasValue: best.db.foreground_polygons != null,
    });
  }

  return {
    pageNumber,
    matched,
    unmatchedSidecar: sidecar.panels.length - matched.length,
    unmatchedDb: dbPanels.length - matched.length,
  };
}

async function fetchPanelsForIssue(
  book: string,
  issue: string,
): Promise<DBPanel[]> {
  const { data, error } = await supabase
    .from("panels")
    .select(
      "id, panel_id, page_number, sort_order, bounding_box, foreground_polygons",
    )
    .eq("book_id", book)
    .eq("issue_id", issue);
  if (error) throw new Error(`fetch panels: ${error.message}`);
  return (data ?? []) as DBPanel[];
}

async function main() {
  const { book, issue, overwrite, dryRun } = parseArgs();
  const FG_DIR = join(
    PROJECT_ROOT,
    "assets",
    "comics",
    book,
    issue,
    "data",
    "foreground",
  );
  if (!(await fs.pathExists(FG_DIR))) {
    console.error(
      `❌ No foreground sidecars at ${FG_DIR} — run extract-foreground-masks first.`,
    );
    process.exit(1);
  }

  const sidecarFiles = (await glob("page-*.json", { cwd: FG_DIR })).sort();
  const dbPanels = await fetchPanelsForIssue(book, issue);
  const dbByPage = new Map<number, DBPanel[]>();
  for (const p of dbPanels) {
    const list = dbByPage.get(p.page_number) ?? [];
    list.push(p);
    dbByPage.set(p.page_number, list);
  }

  console.log(
    `\n🔗 Joining foreground sidecars (${sidecarFiles.length} pages) to ${dbPanels.length} DB panels for ${book}/${issue}\n`,
  );

  const IOU_THRESHOLD = 0.7;
  const planByPage: PageMatchResult[] = [];
  let totalMatched = 0;
  let totalSkippedAlreadyHas = 0;
  for (const filename of sidecarFiles) {
    const m = /page-(\d+)\.json$/.exec(filename);
    const pageNumber = m && m[1] ? parseInt(m[1], 10) : NaN;
    if (Number.isNaN(pageNumber)) continue;

    const sidecar = (await fs.readJSON(
      join(FG_DIR, filename),
    )) as ForegroundSidecar;
    const dbForPage = dbByPage.get(pageNumber) ?? [];
    if (sidecar.panels.length === 0 && dbForPage.length === 0) continue;

    const result = matchPage(pageNumber, sidecar, dbForPage, IOU_THRESHOLD);
    planByPage.push(result);
    totalMatched += result.matched.length;
    if (!overwrite) {
      totalSkippedAlreadyHas += result.matched.filter(
        (m) => m.alreadyHasValue,
      ).length;
    }

    const padded = String(pageNumber).padStart(2, "0");
    console.log(
      `   page-${padded}  matched ${result.matched.length}/${sidecar.panels.length} sidecar panel(s); db has ${dbForPage.length}; unmatched-side=${result.unmatchedSidecar} unmatched-db=${result.unmatchedDb}`,
    );
    for (const mp of result.matched) {
      const flag = mp.alreadyHasValue ? " (already-set)" : "";
      console.log(`      → ${mp.panelLabel} iou=${mp.iou.toFixed(3)}${flag}`);
    }
  }

  if (dryRun) {
    console.log(
      `\n   --dry-run: would update ${totalMatched - totalSkippedAlreadyHas} panel(s); ${totalSkippedAlreadyHas} skipped (already set; pass --overwrite to replace).\n`,
    );
    return;
  }

  let updated = 0;
  let skipped = 0;
  for (const result of planByPage) {
    for (const mp of result.matched) {
      if (mp.alreadyHasValue && !overwrite) {
        skipped++;
        continue;
      }
      const upd = await supabase
        .from("panels")
        .update({ foreground_polygons: mp.payload })
        .eq("id", mp.dbPanelId);
      if (upd.error)
        throw new Error(`update panel ${mp.panelLabel}: ${upd.error.message}`);
      updated++;
    }
  }
  console.log(
    `\n✅ Updated ${updated} panel(s)${skipped > 0 ? `, skipped ${skipped} already-set (use --overwrite to replace)` : ""}.\n`,
  );
}

main().catch((err) => {
  console.error("❌ backfill-foreground-polygons:", err);
  process.exit(1);
});

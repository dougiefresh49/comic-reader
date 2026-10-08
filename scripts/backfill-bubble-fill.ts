#!/usr/bin/env node
/**
 * Backfill `bubbles.fill_color` (#575): sample the colour under each
 * bubble's words (its balloon fill when it has no word boxes, #672) from its page image, one download per page. Writes PRODUCTION unless
 * `--dry-run`, which samples and prints each bubble's colour, its text and
 * the highlight colour the reader would pick, and writes nothing. By default
 * only rows with no colour are filled; `--force` recomputes every row. No
 * Gemini, ElevenLabs or Roboflow call.
 *
 * The pixel box is `box_2d` when it holds numeric x, y, width and height,
 * else the `style` percents times the decoded image's size (some issue-1
 * rows carry only `{"index":N}` in `box_2d`). A row with neither is skipped.
 * When it has stored `text_geometry` word boxes, the sample is read inside
 * them (#672).
 *
 * Rows are read with `select("*")` and the colour is filtered here, so a dry
 * run also works before the column's migration is applied.
 *
 * Usage: pnpm tsx --env-file=.env scripts/backfill-bubble-fill.ts
 *          --book <book> [--issue <issue-N>] [--dry-run] [--force]
 */

import { supabase } from "./lib/supabase.js";
import {
  decodeRawImage,
  pixelBoxOf,
  sampleFillColorRaw,
  type PixelBox,
} from "~/lib/bubble-fill";
import { highlightColorFor } from "~/lib/highlight-color";
import { pageStoragePath } from "~/lib/storage";

const USAGE =
  "Usage: pnpm tsx --env-file=.env scripts/backfill-bubble-fill.ts --book <book> [--issue <issue-N>] [--dry-run] [--force]";

type BubbleRow = {
  id: string;
  sort_order: number;
  box_2d: unknown;
  style: unknown;
  ocr_text: string | null;
  text_geometry?: unknown;
  fill_color?: string | null;
};

function fail(why: string): never {
  console.error(why);
  process.exit(1);
}

/** Strict: an unknown flag fails, so a typo never turns into a write. */
function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = { book: "", issue: "", dryRun: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--force") opts.force = true;
    else if (arg === "--book" || arg === "--issue") {
      const next = argv[++i];
      if (!next || next.startsWith("--"))
        fail(`${arg} needs a value\n${USAGE}`);
      if (arg === "--book") opts.book = next;
      else opts.issue = next;
    } else fail(`unknown argument "${arg}"\n${USAGE}`);
  }
  if (!opts.book) fail(USAGE);
  return opts;
}

/** A `style` box ("61.23%" strings) in page pixels, or null. */
function styleBox(style: unknown, width: number, height: number) {
  if (style === null || typeof style !== "object") return null;
  const s = style as Record<string, unknown>;
  const pct = (v: unknown) =>
    typeof v === "string" && /^-?[\d.]+%$/.test(v.trim())
      ? parseFloat(v) / 100
      : NaN;
  const [l, t, w, h] = [s.left, s.top, s.width, s.height].map(pct);
  if (![l, t, w, h].every((n) => Number.isFinite(n))) return null;
  return {
    x: l! * width,
    y: t! * height,
    width: w! * width,
    height: h! * height,
  } satisfies PixelBox;
}

const opts = parseArgs();

// Pages come from `pages`, filtered by book (and issue), so no `issues` query.
let pageQuery = supabase
  .from("pages")
  .select("issue_id, number")
  .eq("book_id", opts.book);
if (opts.issue) pageQuery = pageQuery.eq("issue_id", opts.issue);
const { data: pages, error: pagesErr } = await pageQuery
  .order("issue_id")
  .order("number");
if (pagesErr) fail(`pages read failed: ${pagesErr.message}`);
if (!pages?.length)
  fail(`no pages for book ${opts.book}${opts.issue ? ` ${opts.issue}` : ""}`);

console.log(
  `${opts.dryRun ? "DRY RUN, nothing written. " : ""}${opts.force ? "Recomputing every row." : "Filling rows with no colour."}`,
);

let totalFilled = 0;
let totalSkipped = 0;
for (const { issue_id: issueId, number: pageNumber } of pages as {
  issue_id: string;
  number: number;
}[]) {
  const label = `${issueId} page ${pageNumber}`;
  const { data, error } = await supabase
    .from("bubbles")
    .select("*")
    .eq("book_id", opts.book)
    .eq("issue_id", issueId)
    .eq("page_number", pageNumber)
    .order("sort_order");
  if (error) fail(`bubbles read failed for ${label}: ${error.message}`);
  const rows = (data as BubbleRow[]).filter(
    (r) => opts.force || r.fill_color == null,
  );
  if (rows.length === 0) continue;

  const { data: blob, error: dlErr } = await supabase.storage
    .from("comic-pages")
    .download(pageStoragePath(opts.book, issueId, pageNumber));
  if (dlErr || !blob) {
    console.warn(
      `${label}: page image download failed (${dlErr?.message ?? "no image"}), ${rows.length} skipped`,
    );
    totalSkipped += rows.length;
    continue;
  }
  const image = await decodeRawImage(new Uint8Array(await blob.arrayBuffer()));

  let filled = 0;
  let skipped = 0;
  for (const row of rows) {
    const box =
      pixelBoxOf(row.box_2d) ?? styleBox(row.style, image.width, image.height);
    const color = box
      ? sampleFillColorRaw(image, box, row.text_geometry)
      : null;
    if (opts.dryRun) {
      const text = (row.ocr_text ?? "").replace(/\s+/g, " ").slice(0, 60);
      console.log(
        `  ${row.id.slice(0, 8)} ${box ? (color ?? "null   ") : "no box "} -> ${highlightColorFor(color)}  "${text}"`,
      );
    }
    if (!color) {
      skipped++;
      // Under --force a stale colour is cleared when the new sample finds none.
      if (!(opts.force && row.fill_color != null)) continue;
    } else filled++;
    if (opts.dryRun) continue;
    const { data: updated, error: upErr } = await supabase
      .from("bubbles")
      .update({ fill_color: color })
      .eq("id", row.id)
      .eq("book_id", opts.book)
      .eq("issue_id", issueId)
      .select("id");
    if (upErr) fail(`fill_color update failed for ${row.id}: ${upErr.message}`);
    if (updated?.length !== 1)
      fail(`fill_color update for ${row.id} matched ${updated?.length} rows`);
  }
  console.log(
    `${opts.issue ? "" : `${issueId} `}page ${pageNumber}: ${filled} filled, ${skipped} skipped`,
  );
  totalFilled += filled;
  totalSkipped += skipped;
}
console.log(
  `total: ${totalFilled} filled, ${totalSkipped} skipped${opts.dryRun ? " (dry run)" : ""}`,
);

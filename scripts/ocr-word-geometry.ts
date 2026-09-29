#!/usr/bin/env node
/**
 * Word boxes for lettered bubbles from Apple Vision (#61), stored as
 * `bubbles.text_geometry` for in-bubble karaoke (#87). macOS only, free and
 * local. Dry run by default: prints a report and writes nothing. `--write`
 * updates `text_geometry` on every candidate bubble of the scanned pages in
 * PRODUCTION (null when no line was assigned). `--json` prints
 * `[{bubbleId, pageNumber, geometry}]` to stdout and the report to stderr.
 *
 * Usage: pnpm exec tsx --env-file=.env scripts/ocr-word-geometry.ts
 *          --book <book> --issue <issue-N> [--page N ...] [--write] [--json]
 */

import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { supabase } from "./lib/supabase.js";
import { stripAudioTags } from "~/components/zen-comic-reader/text-utils";

const USAGE =
  "Usage: pnpm exec tsx --env-file=.env scripts/ocr-word-geometry.ts --book <book> --issue <issue-N> [--page N ...] [--write] [--json]";
const HELPER = fileURLToPath(
  new URL("./vision/ocr-page.swift", import.meta.url),
);
const CANDIDATE_TYPES = ["SPEECH", "NARRATION", "CAPTION"];
const WATERMARK = /readcomiconline|read more free comics/i;
const PAD = 0.02; // bubble rect padding, page-normalized (2% of the page)
const MIN_COVER = 0.5;

// Mirrors the shape #62 declares in src/types/text-geometry.ts; import it
// from there once #62 merges.
type Box = [number, number, number, number]; // x, y, w, h; page-normalized, top-left origin
type TextGeometry = {
  engine: string;
  image: { w: number; h: number; sha: string };
  lines: { box: Box; words: { t: string; box: Box; conf: number }[] }[];
};
type Line = TextGeometry["lines"][number];

type Bubble = {
  id: string;
  page_number: number;
  type: string;
  style: unknown;
  text_with_cues: string | null;
};

function fail(why: string): never {
  console.error(why);
  process.exit(1);
}

/** Strict: an unknown flag fails, so a typo never widens a --write. */
function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = {
    book: "",
    issue: "",
    pages: [] as number[],
    write: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--write") opts.write = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--book" || arg === "--issue" || arg === "--page") {
      const next = argv[++i];
      if (!next || next.startsWith("--"))
        fail(`${arg} needs a value\n${USAGE}`);
      if (arg === "--book") opts.book = next;
      else if (arg === "--issue") opts.issue = next;
      else {
        const n = Number(next);
        if (!Number.isInteger(n) || n < 1)
          fail(`--page: "${next}" is not a page number`);
        opts.pages.push(n);
      }
    } else fail(`unknown argument "${arg}"\n${USAGE}`);
  }
  if (!opts.book || !opts.issue) fail(USAGE);
  return opts;
}

function requireSwift() {
  if (process.platform !== "darwin") {
    fail(
      `ocr-word-geometry needs macOS for Apple Vision (this is ${process.platform}).`,
    );
  }
  const probe = spawnSync("swift", ["--version"], { stdio: "ignore" });
  if (probe.error || probe.status !== 0) {
    fail(
      "ocr-word-geometry needs `swift` on PATH for Apple Vision (install the Xcode command line tools: xcode-select --install).",
    );
  }
}

/**
 * Uppercase, ’ to ', then split on every character but A-Z, 0-9 and ', so a
 * hyphen separates tokens (FLEET- / FOOTED still matches FLEET-FOOTED) and
 * DON'T stays one token.
 */
function tokens(text: string): string[] {
  return text
    .toUpperCase()
    .replace(/’/g, "'")
    .split(/[^A-Z0-9']+/)
    .filter((t) => /[A-Z0-9]/.test(t));
}

function lineText(line: Line): string {
  return line.words.map((w) => w.t).join(" ");
}

function lineTokens(line: Line): string[] {
  return line.words.flatMap((w) => tokens(w.t));
}

/** `bubbles.style` page-% strings as a padded, page-normalized rect. */
function paddedRect(style: unknown): Box | null {
  if (!style || typeof style !== "object") return null;
  const s = style as Record<string, unknown>;
  const n = (k: string) =>
    typeof s[k] === "string" ? parseFloat(s[k]) / 100 : NaN;
  const [x, y, w, h] = [n("left"), n("top"), n("width"), n("height")];
  if ([x, y, w, h].some((v) => !Number.isFinite(v))) return null;
  return [x - PAD, y - PAD, w + 2 * PAD, h + 2 * PAD];
}

function contains(rect: Box, px: number, py: number): boolean {
  return (
    px >= rect[0] &&
    px <= rect[0] + rect[2] &&
    py >= rect[1] &&
    py <= rect[1] + rect[3]
  );
}

function intersection(a: Box, b: Box): number {
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

function sameBox(a: Box, b: Box): boolean {
  return a.every((v, i) => v === b[i]);
}

/** How many of `want` (a multiset) appear in `have`, each used once. */
function covered(want: string[], have: string[]): number {
  const pool = new Map<string, number>();
  for (const t of have) pool.set(t, (pool.get(t) ?? 0) + 1);
  let hits = 0;
  for (const t of want) {
    const left = pool.get(t) ?? 0;
    if (left > 0) {
      hits++;
      pool.set(t, left - 1);
    }
  }
  return hits;
}

function runVision(files: string[]): TextGeometry[] {
  const run = spawnSync("swift", [HELPER, ...files], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (run.error) fail(`swift failed to start: ${run.error.message}`);
  if (run.status !== 0) fail(`swift exited with status ${run.status}`);
  const out = JSON.parse(run.stdout) as TextGeometry[];
  if (out.length !== files.length) {
    fail(`swift returned ${out.length} pages for ${files.length} images`);
  }
  return out;
}

const args = parseArgs();
requireSwift();
const log = args.json ? console.error : console.log;

let pageQuery = supabase
  .from("pages")
  .select("number, width, height, storage_path")
  .eq("book_id", args.book)
  .eq("issue_id", args.issue)
  .order("number");
if (args.pages.length) pageQuery = pageQuery.in("number", args.pages);
const { data: pageRows, error: pageError } = await pageQuery;
if (pageError) fail(`pages: ${pageError.message}`);
const missing = args.pages.filter((n) => !pageRows.some((p) => p.number === n));
if (missing.length) fail(`no pages row for page(s) ${missing.join(", ")}`);
const pages = pageRows.filter((p) => {
  if (p.storage_path) return true;
  log(`page ${p.number}: no storage_path, skipped`);
  return false;
});
if (!pages.length) fail("no pages to scan");

const bubbleQuery = supabase
  .from("bubbles")
  .select("id, page_number, type, style, text_with_cues")
  .eq("book_id", args.book)
  .eq("issue_id", args.issue)
  .eq("ignored", false)
  .in("type", CANDIDATE_TYPES)
  .not("style", "is", null)
  .in(
    "page_number",
    pages.map((p) => p.number),
  )
  .order("page_number")
  .order("sort_order");
const { data: bubbleRows, error: bubbleError } = await bubbleQuery;
if (bubbleError) fail(`bubbles: ${bubbleError.message}`);
const bubbles = bubbleRows as Bubble[];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-word-geometry-"));
// On exit, so the images go even when fail() or Ctrl-C ends the run.
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => process.exit(1));
}
const files: string[] = [];
for (const p of pages) {
  const { data, error } = await supabase.storage
    .from("comic-pages")
    .download(p.storage_path!);
  if (error) fail(`download ${p.storage_path}: ${error.message}`);
  const file = path.join(tmp, `page-${p.number}.webp`);
  fs.writeFileSync(file, Buffer.from(await data.arrayBuffer()));
  files.push(file);
}
const started = Date.now();
const geometries = runVision(files);
log(
  `Apple Vision: ${pages.length} page(s) in ${((Date.now() - started) / 1000).toFixed(1)} s`,
);

const results: {
  bubbleId: string;
  pageNumber: number;
  geometry: TextGeometry | null;
}[] = [];
let bubblesWithLines = 0;
let wordsCovered = 0;
let wordsTotal = 0;

pages.forEach((page, i) => {
  const geo = geometries[i]!;
  const pageBubbles = bubbles
    .filter((b) => b.page_number === page.number)
    .map((b) => ({
      bubble: b,
      rect: paddedRect(b.style),
      tokens: tokens(stripAudioTags(b.text_with_cues ?? "")),
      lines: [] as Line[],
    }));

  const dropped: Line[] = [];
  const unassigned: Line[] = [];
  const flat: Line[] = [];
  for (const line of geo.lines) {
    if (WATERMARK.test(lineText(line))) {
      dropped.push(line);
      continue;
    }
    if (
      line.words.length > 1 &&
      line.words.every((w) => sameBox(w.box, line.box))
    ) {
      flat.push(line);
    }
    const lt = lineTokens(line);
    const cx = line.box[0] + line.box[2] / 2;
    const cy = line.box[1] + line.box[3] / 2;
    let best: {
      entry: (typeof pageBubbles)[number];
      cover: number;
      area: number;
    } | null = null;
    for (const entry of pageBubbles) {
      if (!entry.rect || !lt.length || !contains(entry.rect, cx, cy)) continue;
      const cover = covered(lt, entry.tokens) / lt.length;
      if (cover < MIN_COVER) continue;
      const area = intersection(entry.rect, line.box);
      if (
        !best ||
        cover > best.cover ||
        (cover === best.cover && area > best.area)
      ) {
        best = { entry, cover, area };
      }
    }
    if (best) best.entry.lines.push(line);
    else unassigned.push(line);
  }

  const words = geo.lines.reduce((sum, l) => sum + l.words.length, 0);
  log(`\nPage ${page.number}: ${geo.lines.length} lines / ${words} words`);
  for (const entry of pageBubbles) {
    entry.lines.sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
    const hits = covered(entry.tokens, entry.lines.flatMap(lineTokens));
    wordsCovered += hits;
    wordsTotal += entry.tokens.length;
    if (entry.lines.length) bubblesWithLines++;
    log(
      `  ${entry.bubble.id.slice(0, 8)} ${entry.bubble.type.padEnd(9)} lines ${entry.lines.length}  words ${hits}/${entry.tokens.length}  "${stripAudioTags(entry.bubble.text_with_cues ?? "")}"`,
    );
    results.push({
      bubbleId: entry.bubble.id,
      pageNumber: page.number,
      geometry: entry.lines.length
        ? { engine: geo.engine, image: geo.image, lines: entry.lines }
        : null,
    });
  }
  for (const line of unassigned) log(`  unassigned: "${lineText(line)}"`);
  for (const line of dropped) log(`  dropped watermark: "${lineText(line)}"`);
  for (const line of flat) {
    log(`  no word granularity: "${lineText(line)}"`);
  }
});

log(
  `\nTotal: ${bubblesWithLines}/${results.length} bubbles with at least one line, word coverage ${wordsCovered}/${wordsTotal}`,
);

if (args.json) console.log(JSON.stringify(results, null, 2));

if (!args.write) {
  log(
    "Dry run: nothing written. Pass --write to update bubbles.text_geometry.",
  );
} else {
  let written = 0;
  for (const r of results) {
    const { data, error } = await supabase
      .from("bubbles")
      .update({ text_geometry: r.geometry })
      .eq("id", r.bubbleId)
      .eq("book_id", args.book)
      .eq("issue_id", args.issue)
      .select("id");
    if (error) fail(`update ${r.bubbleId}: ${error.message}`);
    if (data.length !== 1)
      fail(`update ${r.bubbleId}: matched ${data.length} rows`);
    written++;
  }
  const withGeometry = results.filter((r) => r.geometry).length;
  log(`Wrote text_geometry on ${written} bubbles (${withGeometry} non-null).`);
}

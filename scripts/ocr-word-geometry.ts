#!/usr/bin/env node
/**
 * Word boxes for lettered bubbles, stored as `bubbles.text_geometry` for
 * in-bubble karaoke (#87). `--engine cloud` (default, #572) sends each page
 * to Google Cloud Vision (one call per page, any OS, needs
 * GOOGLE_CLOUD_VISION_API_KEY); `--engine apple` runs Apple Vision locally
 * (#61, macOS only, free). Dry run by default: prints a report and writes
 * nothing. `--write` updates `text_geometry` on every candidate bubble of the
 * scanned pages in PRODUCTION (null when no line was assigned). `--json`
 * prints `[{bubbleId, pageNumber, geometry}]` to stdout and the report to
 * stderr. Refuses to run under DRY_RUN, whose fake OCR has no lines.
 *
 * Usage: pnpm exec tsx --env-file=.env scripts/ocr-word-geometry.ts
 *          --book <book> --issue <issue-N> [--engine cloud|apple]
 *          [--page N ...] [--write] [--json]
 */

import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { supabase } from "./lib/supabase.js";
import { buildWordTimings } from "~/components/zen-comic-reader/text-utils";
import { cloudVisionGeometry } from "~/lib/cloud-vision-geometry";
import { isDryRun } from "~/lib/fakes/dry-run";
import {
  assignLinesToBubbles,
  bubbleText,
  lineText,
  whereWordGeometryCandidate,
} from "~/lib/word-geometry-assign";
import { alignTimingsToGeometry } from "~/lib/word-geometry-match";
import type { CharacterAlignment } from "~/types";
import type { TextGeometry } from "~/types/text-geometry";

const USAGE =
  "Usage: pnpm exec tsx --env-file=.env scripts/ocr-word-geometry.ts --book <book> --issue <issue-N> [--engine cloud|apple] [--page N ...] [--write] [--json]";
const HELPER = fileURLToPath(
  new URL("./vision/ocr-page.swift", import.meta.url),
);
const ENGINES = ["cloud", "apple"] as const;

type Bubble = {
  id: string;
  page_number: number;
  type: string;
  style: unknown;
  text_with_cues: string | null;
  ocr_text: string | null;
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
    engine: "cloud" as (typeof ENGINES)[number],
    write: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--write") opts.write = true;
    else if (arg === "--json") opts.json = true;
    else if (
      arg === "--book" ||
      arg === "--issue" ||
      arg === "--page" ||
      arg === "--engine"
    ) {
      const next = argv[++i];
      if (!next || next.startsWith("--"))
        fail(`${arg} needs a value\n${USAGE}`);
      if (arg === "--book") opts.book = next;
      else if (arg === "--issue") opts.issue = next;
      else if (arg === "--engine") {
        const engine = ENGINES.find((e) => e === next);
        if (!engine) fail(`--engine: "${next}" is not one of cloud, apple`);
        opts.engine = engine;
      } else {
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
if (isDryRun()) {
  fail(
    "DRY_RUN is set: its fake OCR has no lines, and a --write of it would null every text_geometry. Unset DRY_RUN to run this script.",
  );
}
if (args.engine === "apple") requireSwift();
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

const bubbleQuery = whereWordGeometryCandidate(
  supabase
    .from("bubbles")
    .select("id, page_number, type, style, text_with_cues, ocr_text")
    .eq("book_id", args.book)
    .eq("issue_id", args.issue),
)
  .in(
    "page_number",
    pages.map((p) => p.number),
  )
  .order("page_number")
  .order("sort_order");
const { data: bubbleRows, error: bubbleError } = await bubbleQuery;
if (bubbleError) fail(`bubbles: ${bubbleError.message}`);
const bubbles = bubbleRows as Bubble[];

const { data: timestampRows, error: timestampError } = await supabase
  .from("audio_timestamps")
  .select("bubble_id, alignment")
  .eq("book_id", args.book)
  .eq("issue_id", args.issue)
  .in(
    "bubble_id",
    bubbles.map((b) => b.id),
  );
if (timestampError) fail(`audio_timestamps: ${timestampError.message}`);
const alignmentOf = new Map(
  (
    timestampRows as {
      bubble_id: string;
      alignment: CharacterAlignment | null;
    }[]
  ).map((t) => [t.bubble_id, t.alignment]),
);

const images: Buffer[] = [];
for (const p of pages) {
  const { data, error } = await supabase.storage
    .from("comic-pages")
    .download(p.storage_path!);
  if (error) fail(`download ${p.storage_path}: ${error.message}`);
  images.push(Buffer.from(await data.arrayBuffer()));
}

const started = Date.now();
let geometries: TextGeometry[];
if (args.engine === "apple") {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-word-geometry-"));
  // On exit, so the images go even when fail() or Ctrl-C ends the run.
  process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => process.exit(1));
  }
  const files = pages.map((p, i) => {
    const file = path.join(tmp, `page-${p.number}.webp`);
    fs.writeFileSync(file, images[i]!);
    return file;
  });
  geometries = runVision(files);
} else {
  geometries = [];
  for (const [i, p] of pages.entries()) {
    try {
      geometries.push(await cloudVisionGeometry(images[i]!));
    } catch (err) {
      fail(`page ${p.number}: ${err instanceof Error ? err.message : err}`);
    }
  }
}
log(
  `${args.engine === "apple" ? "Apple Vision" : "Cloud Vision"}: ${pages.length} page(s) in ${((Date.now() - started) / 1000).toFixed(1)} s`,
);

/** Timing words with a letter or digit, and how many got a box (#62). */
function timingWordsBoxed(
  alignment: CharacterAlignment,
  geometry: TextGeometry | null,
) {
  const { words } = buildWordTimings(alignment);
  const lettered = words
    .map((w, i) => ({ w, i }))
    .filter(({ w }) => /[a-z0-9]/i.test(w.word));
  if (!geometry) return { boxed: 0, total: lettered.length };
  const { boxesByTimingIndex } = alignTimingsToGeometry(words, geometry);
  return {
    boxed: lettered.filter(({ i }) => boxesByTimingIndex[i]!.length).length,
    total: lettered.length,
  };
}

const results: {
  bubbleId: string;
  pageNumber: number;
  geometry: TextGeometry | null;
}[] = [];
let bubblesWithLines = 0;
let wordsCovered = 0;
let wordsTotal = 0;
let timingBoxed = 0;
let timingTotal = 0;

pages.forEach((page, i) => {
  const geo = geometries[i]!;
  const assigned = assignLinesToBubbles(
    bubbles.filter((b) => b.page_number === page.number),
    geo,
  );

  const words = geo.lines.reduce((sum, l) => sum + l.words.length, 0);
  log(`\nPage ${page.number}: ${geo.lines.length} lines / ${words} words`);
  for (const a of assigned.bubbles) {
    const lines = a.geometry?.lines.length ?? 0;
    wordsCovered += a.wordsCovered;
    wordsTotal += a.wordsTotal;
    if (lines) bubblesWithLines++;
    const alignment = alignmentOf.get(a.bubble.id);
    let timing = "no alignment";
    if (alignment) {
      const t = timingWordsBoxed(alignment, a.geometry);
      timingBoxed += t.boxed;
      timingTotal += t.total;
      timing = `${t.boxed}/${t.total}`;
    }
    const source = a.bubble.text_with_cues === null ? " (ocr_text)" : "";
    log(
      `  ${a.bubble.id.slice(0, 8)} ${a.bubble.type.padEnd(9)} lines ${lines}  words ${a.wordsCovered}/${a.wordsTotal}  timing words boxed ${timing}  "${bubbleText(a.bubble)}"${source}`,
    );
    results.push({
      bubbleId: a.bubble.id,
      pageNumber: page.number,
      geometry: a.geometry,
    });
  }
  for (const line of assigned.unassigned) {
    log(`  unassigned: "${lineText(line)}"`);
  }
  for (const line of assigned.dropped) {
    log(`  dropped watermark: "${lineText(line)}"`);
  }
  for (const line of assigned.flat) {
    log(`  no word granularity: "${lineText(line)}"`);
  }
});

log(
  `\nTotal: ${bubblesWithLines}/${results.length} bubbles with at least one line, word coverage ${wordsCovered}/${wordsTotal}, timing words boxed ${timingBoxed}/${timingTotal}`,
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

#!/usr/bin/env node
/**
 * Clean the source watermark off stored page images (#541), in two phases
 * that never run together.
 *
 * Phase 1, clean (paid: one Gemini call per page, plus an image edit per
 * overlay found). Reads pages, writes only under --out:
 *   pnpm fix-page-watermarks -- --book <id> --issue <issue-id> [--pages 4,5] --out <dir>
 *   pnpm fix-page-watermarks -- --from-dir <dir> [--book <id>] [--issue <issue-id>] [--pages 4,5] --out <dir>
 * --from-dir reads <dir>/<book>/<issue>/page-NN.webp. For every page with a
 * fix, --out gets <book>/<issue>/page-NN.webp (cleaned, encoded as stored),
 * page-NN.before.png and page-NN.after.png (the fixed region), and
 * page-NN.diff.png (quarter scale, red where a pixel moved by more than 32,
 * green around each fix). One report.json covers the run.
 *
 * Phase 2, upload (PRODUCTION Storage write, no DB row changes):
 *   pnpm fix-page-watermarks -- --upload <dir>
 * Reads <dir>/report.json and upserts each cleaned WebP to comic-pages at its
 * pageStoragePath when its size equals the `pages` row's; skips it otherwise.
 */

import fs from "fs";
import os from "os";
import path from "path";
import sharp from "sharp";
import { supabase } from "./lib/supabase.js";
import { GEMINI_IMAGE_EDIT_USD_PER_IMAGE } from "~/lib/models.js";
import { encodePageWebp, WEBP_QUALITY } from "~/lib/page-images.js";
import {
  cleanPageWatermarks,
  decodeRgb,
  type Box,
  type RgbImage,
  type WatermarkFailure,
  type WatermarkFix,
} from "~/lib/page-watermark.js";
import { pageStoragePath } from "~/lib/storage.js";

const BUCKET = "comic-pages";
/** Re-encode noise tops out near 28 (#541 brief), so a move past 32 is a change. */
const DIFF_THRESHOLD = 32;
const DIFF_SCALE = 4;
const CONCURRENCY = 4;
const STEPS = ["page-watermark-detect", "page-watermark-edit"];

const USAGE = `Usage:
  clean:  pnpm fix-page-watermarks -- (--book <id> --issue <issue-id> | --from-dir <dir> [--book <id>] [--issue <issue-id>]) [--pages 4,5] --out <dir>
  upload: pnpm fix-page-watermarks -- --upload <dir>`;

type PageSource = {
  book: string;
  issue: string;
  page: number;
  source: string;
  load: () => Promise<Buffer>;
};

type PageStats = {
  overInside: number;
  overOutside: number;
  maxOutside: number;
  meanDiff: number;
};

type PageReport = {
  book: string;
  issue: string;
  page: number;
  source: string;
  width: number;
  height: number;
  fixes: WatermarkFix[];
  failures: WatermarkFailure[];
  /** Paths under the out dir; absent when the page had no fix. */
  files?: { webp: string; before: string; after: string; diff: string };
  stats?: PageStats;
};

type Report = {
  phase: "clean";
  createdAt: string;
  source: string;
  diffThreshold: number;
  webpQuality: number;
  pages: PageReport[];
  spend: { detectCalls: number; editCalls: number; usdFromLlmCalls: number };
};

function fail(why: string): never {
  console.error(why);
  console.error(USAGE);
  process.exit(1);
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    const next = i >= 0 ? argv[i + 1] : undefined;
    return next && !next.startsWith("--") ? next : undefined;
  };
  const upload = value("--upload");
  const out = value("--out");
  const fromDir = value("--from-dir");
  const book = value("--book");
  const issue = value("--issue");
  if (upload) {
    if (out || fromDir || book || issue || argv.includes("--pages")) {
      fail("--upload runs alone: clean and upload are separate runs.");
    }
    return { mode: "upload" as const, dir: expandHome(upload) };
  }
  if (!out) fail("--out <dir> is required for a clean run.");
  if (!fromDir && (!book || !issue)) {
    fail("A clean run needs --book and --issue, or --from-dir.");
  }
  let pages: Set<number> | undefined;
  if (argv.includes("--pages")) {
    const raw = value("--pages") ?? fail("--pages needs a value, e.g. 4,5");
    pages = new Set();
    for (const part of raw.split(",")) {
      const m =
        /^(\d+)(?:-(\d+))?$/.exec(part) ??
        fail(`--pages: "${part}" is not N or N-M`);
      for (let n = Number(m[1]); n <= Number(m[2] ?? m[1]); n++) pages.add(n);
    }
  }
  return {
    mode: "clean" as const,
    out: expandHome(out),
    fromDir: fromDir && expandHome(fromDir),
    book,
    issue,
    pages,
  };
}

function pageNumber(name: string): number | null {
  const m = /^page-0*(\d+)\.webp$/.exec(name);
  return m ? Number(m[1]) : null;
}

function sourcesFromDir(
  dir: string,
  book?: string,
  issue?: string,
): PageSource[] {
  const list: PageSource[] = [];
  const subdirs = (d: string) =>
    fs
      .readdirSync(d, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  for (const b of book ? [book] : subdirs(dir)) {
    for (const i of issue ? [issue] : subdirs(path.join(dir, b))) {
      const folder = path.join(dir, b, i);
      if (!fs.existsSync(folder)) continue;
      for (const name of fs.readdirSync(folder).sort()) {
        const page = pageNumber(name);
        if (page === null) continue;
        const file = path.join(folder, name);
        list.push({
          book: b,
          issue: i,
          page,
          source: file,
          load: async () => fs.readFileSync(file),
        });
      }
    }
  }
  return list;
}

async function sourcesFromStorage(
  book: string,
  issue: string,
): Promise<PageSource[]> {
  const { data, error } = await supabase
    .from("pages")
    .select("number")
    .eq("book_id", book)
    .eq("issue_id", issue)
    .order("number");
  if (error) throw new Error(`pages rows ${book}/${issue}: ${error.message}`);
  return (data as Array<{ number: number }>).map(({ number }) => {
    const key = pageStoragePath(book, issue, number);
    return {
      book,
      issue,
      page: number,
      source: `${BUCKET}/${key}`,
      load: async () => {
        const res = await supabase.storage.from(BUCKET).download(key);
        if (res.error) throw new Error(`download ${key}: ${res.error.message}`);
        return Buffer.from(await res.data.arrayBuffer());
      },
    };
  });
}

function union(boxes: Box[]): Box {
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.width));
  const y1 = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

const inBox = (x: number, y: number, b: Box) =>
  x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height;

/** Per-pixel max channel difference, plus the stats the report carries. */
function compare(before: RgbImage, after: RgbImage, regions: Box[]) {
  const { width, height } = before;
  const moved = new Uint8Array(width * height);
  const stats: PageStats = {
    overInside: 0,
    overOutside: 0,
    maxOutside: 0,
    meanDiff: 0,
  };
  let sum = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      let d = 0;
      for (let c = 0; c < 3; c++) {
        const v = Math.abs(before.data[p * 3 + c]! - after.data[p * 3 + c]!);
        sum += v;
        if (v > d) d = v;
      }
      const inside = regions.some((r) => inBox(x, y, r));
      if (d > DIFF_THRESHOLD) {
        moved[p] = 1;
        if (inside) stats.overInside++;
        else stats.overOutside++;
      }
      if (!inside && d > stats.maxOutside) stats.maxOutside = d;
    }
  }
  stats.meanDiff = Math.round((sum / (width * height * 3)) * 1000) / 1000;
  return { moved, stats };
}

/** The page in grey at quarter scale, red where a pixel moved, green boxes. */
async function diffImage(
  before: RgbImage,
  moved: Uint8Array,
  regions: Box[],
): Promise<Buffer> {
  const grey = await sharp(before.data, {
    raw: { width: before.width, height: before.height, channels: 3 },
  })
    .resize(
      Math.ceil(before.width / DIFF_SCALE),
      Math.ceil(before.height / DIFF_SCALE),
      { fit: "fill" },
    )
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = grey.info;
  const rgb = Buffer.alloc(w * h * 3);
  for (let p = 0; p < w * h; p++) {
    const v = grey.data[p * grey.info.channels]!;
    rgb[p * 3] = rgb[p * 3 + 1] = rgb[p * 3 + 2] = v;
  }
  const paint = (x: number, y: number, r: number, g: number, b: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 3;
    rgb[i] = r;
    rgb[i + 1] = g;
    rgb[i + 2] = b;
  };
  for (let y = 0; y < before.height; y++) {
    for (let x = 0; x < before.width; x++) {
      if (moved[y * before.width + x]) {
        paint(
          Math.floor(x / DIFF_SCALE),
          Math.floor(y / DIFF_SCALE),
          255,
          0,
          0,
        );
      }
    }
  }
  for (const r of regions) {
    const x0 = Math.floor(r.x / DIFF_SCALE);
    const y0 = Math.floor(r.y / DIFF_SCALE);
    const x1 = Math.min(w - 1, Math.ceil((r.x + r.width) / DIFF_SCALE));
    const y1 = Math.min(h - 1, Math.ceil((r.y + r.height) / DIFF_SCALE));
    for (let t = 0; t < 2; t++) {
      for (let x = x0; x <= x1; x++) {
        paint(x, y0 + t, 0, 255, 0);
        paint(x, y1 - t, 0, 255, 0);
      }
      for (let y = y0; y <= y1; y++) {
        paint(x0 + t, y, 0, 255, 0);
        paint(x1 - t, y, 0, 255, 0);
      }
    }
  }
  return sharp(rgb, { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toBuffer();
}

async function cropPng(img: RgbImage, box: Box): Promise<Buffer> {
  return sharp(img.data, {
    raw: { width: img.width, height: img.height, channels: 3 },
  })
    .extract({ left: box.x, top: box.y, width: box.width, height: box.height })
    .png()
    .toBuffer();
}

const pad = (n: number) => String(n).padStart(2, "0");
const fmtBox = (b: Box) => `[${b.x},${b.y} ${b.width}x${b.height}]`;

async function cleanPage(src: PageSource, out: string): Promise<PageReport> {
  const input = await src.load();
  const before = await decodeRgb(input);
  const result = await cleanPageWatermarks({
    buffer: input,
    bookId: src.book,
    issueId: src.issue,
    pageNumber: src.page,
  });
  const report: PageReport = {
    book: src.book,
    issue: src.issue,
    page: src.page,
    source: src.source,
    width: before.width,
    height: before.height,
    fixes: result.fixes,
    failures: result.failures,
  };
  if (result.fixes.length === 0) return report;

  const webp = await encodePageWebp(result.buffer);
  const after = await decodeRgb(webp);
  if (after.width !== before.width || after.height !== before.height) {
    throw new Error(
      `${src.source}: cleaned ${after.width}x${after.height}, input ${before.width}x${before.height}`,
    );
  }
  const regions = result.fixes.map((f) => f.box);
  const { moved, stats } = compare(before, after, regions);
  const region = union(regions);
  const rel = path.join(src.book, src.issue);
  const base = `page-${pad(src.page)}`;
  fs.mkdirSync(path.join(out, rel), { recursive: true });
  const files = {
    webp: path.join(rel, `${base}.webp`),
    before: path.join(rel, `${base}.before.png`),
    after: path.join(rel, `${base}.after.png`),
    diff: path.join(rel, `${base}.diff.png`),
  };
  fs.writeFileSync(path.join(out, files.webp), webp);
  fs.writeFileSync(path.join(out, files.before), await cropPng(before, region));
  fs.writeFileSync(path.join(out, files.after), await cropPng(after, region));
  fs.writeFileSync(
    path.join(out, files.diff),
    await diffImage(before, moved, regions),
  );
  return { ...report, files, stats };
}

function summaryLine(r: PageReport): string {
  const head = `${r.book}/${r.issue} p${pad(r.page)}`;
  const parts = r.fixes.map((f) => `${f.kind} fixed ${fmtBox(f.box)}`);
  for (const f of r.failures) {
    parts.push(
      `${f.kind} FAILED${f.box ? ` ${fmtBox(f.box)}` : ""}: ${f.reason}`,
    );
  }
  if (parts.length === 0) return `${head}: no watermark`;
  const s = r.stats;
  const tail = s
    ? `; >${DIFF_THRESHOLD} inside ${s.overInside}, outside ${s.overOutside}, max outside ${s.maxOutside}, mean ${s.meanDiff}`
    : "";
  return `${head}: ${parts.join("; ")}${tail}`;
}

async function spendSince(startedAt: string) {
  const { data, error } = await supabase
    .from("llm_calls")
    .select("step, usd_est")
    .in("step", STEPS)
    .gte("created_at", startedAt);
  if (error) {
    console.warn(`llm_calls read failed: ${error.message}`);
    return { detectCalls: 0, editCalls: 0, usdFromLlmCalls: 0 };
  }
  const rows = data as Array<{ step: string; usd_est: number | null }>;
  return {
    detectCalls: rows.filter((r) => r.step === STEPS[0]).length,
    editCalls: rows.filter((r) => r.step === STEPS[1]).length,
    usdFromLlmCalls:
      Math.round(rows.reduce((s, r) => s + (r.usd_est ?? 0), 0) * 1e5) / 1e5,
  };
}

async function runClean(
  args: Extract<ReturnType<typeof parseArgs>, { mode: "clean" }>,
) {
  const startedAt = new Date().toISOString();
  let sources = args.fromDir
    ? sourcesFromDir(args.fromDir, args.book, args.issue)
    : await sourcesFromStorage(args.book!, args.issue!);
  if (args.pages) sources = sources.filter((s) => args.pages!.has(s.page));
  if (sources.length === 0) fail("No pages matched.");
  fs.mkdirSync(args.out, { recursive: true });
  console.log(
    `Cleaning ${sources.length} pages from ${args.fromDir ?? `${BUCKET}/${args.book}/${args.issue}`} into ${args.out}`,
  );

  const reports: PageReport[] = new Array(sources.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < sources.length) {
        const i = next++;
        reports[i] = await cleanPage(sources[i]!, args.out);
        console.log(summaryLine(reports[i]));
      }
    }),
  );

  const spend = await spendSince(startedAt);
  const report: Report = {
    phase: "clean",
    createdAt: startedAt,
    source: args.fromDir ?? `${BUCKET}/${args.book}/${args.issue}`,
    diffThreshold: DIFF_THRESHOLD,
    webpQuality: WEBP_QUALITY,
    pages: reports,
    spend,
  };
  const file = path.join(args.out, "report.json");
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  const fixed = reports.filter((r) => r.files).length;
  const failed = reports.filter((r) => r.failures.length > 0).length;
  const estimate = spend.editCalls * GEMINI_IMAGE_EDIT_USD_PER_IMAGE;
  console.log(
    `\n${reports.length} pages: ${fixed} cleaned, ${failed} with a failure. ` +
      `Gemini: ${spend.detectCalls} detect + ${spend.editCalls} edit calls, ` +
      `$${spend.usdFromLlmCalls} in llm_calls (edits alone ~$${estimate.toFixed(4)} at the per-image rate).`,
  );
  console.log(
    `Report: ${file}. Nothing uploaded; review, then run --upload ${args.out}.`,
  );
}

async function runUpload(dir: string) {
  const file = path.join(dir, "report.json");
  const report = JSON.parse(fs.readFileSync(file, "utf8")) as Report;
  let uploaded = 0;
  for (const r of report.pages) {
    const head = `${r.book}/${r.issue} p${pad(r.page)}`;
    if (!r.files) {
      console.log(`${head}: nothing to upload`);
      continue;
    }
    const webp = fs.readFileSync(path.join(dir, r.files.webp));
    const meta = await sharp(webp).metadata();
    const { data: row, error } = await supabase
      .from("pages")
      .select("width, height")
      .eq("book_id", r.book)
      .eq("issue_id", r.issue)
      .eq("number", r.page)
      .single();
    if (error) {
      console.log(`${head}: skipped, no pages row (${error.message})`);
      continue;
    }
    const want = row as { width: number; height: number };
    if (meta.width !== want.width || meta.height !== want.height) {
      console.log(
        `${head}: skipped, cleaned WebP is ${meta.width}x${meta.height} and the pages row says ${want.width}x${want.height}`,
      );
      continue;
    }
    const key = pageStoragePath(r.book, r.issue, r.page);
    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(key, webp, { contentType: "image/webp", upsert: true });
    if (upErr) throw new Error(`upload ${key}: ${upErr.message}`);
    uploaded++;
    console.log(
      `${head}: uploaded ${BUCKET}/${key} (${meta.width}x${meta.height})`,
    );
  }
  console.log(`\n${uploaded} pages uploaded. No pages row changed.`);
}

async function main() {
  const args = parseArgs();
  if (args.mode === "upload") await runUpload(args.dir);
  else await runClean(args);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

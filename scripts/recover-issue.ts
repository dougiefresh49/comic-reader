#!/usr/bin/env node
/**
 * Recover tmnt-mmpr-iii issue-3 and issue-4 into Supabase so the pipeline can
 * resume them (#78). Dry run by default: prints every planned storage upload
 * and row write. `--execute` performs the same list against PRODUCTION.
 *
 * Usage: pnpm recover-issue -- --book tmnt-mmpr-iii --issue issue-3
 *          [--execute] [--skip-pages 1,34-36] [--dump-payload [path]]
 *
 * issue-3 comes from git (`e562181^`, before assets/ left the repo): raw JPEGs
 * to comic-pages-raw/<book>/issue-3/source/, WebPs plus `pages` rows through
 * storePageImage, and the reviewed bubbles upserted on
 * (book_id, issue_id, legacy_id). issue-4's raw JPEGs are already in
 * comic-pages-raw; it gets WebPs plus `pages` rows only.
 *
 * Never writes the `issues` row, so `has_webp` stays false on both issues.
 */

import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import sharp from "sharp";
import { supabase } from "./lib/supabase.js";
import { selectIssue } from "~/lib/issue-queries.js";
import { storePageImage } from "~/lib/page-images.js";
import { pageStoragePath } from "~/lib/storage.js";
import type { Json } from "~/types/database.js";

const GIT_REV = "e562181^";
const RAW_BUCKET = "comic-pages-raw";

interface Recipe {
  /** Directory at GIT_REV holding bubbles.json, pages.json and pages/*.jpg; absent = raw JPEGs already in storage. */
  gitDir?: string;
  /** Bounds --skip-pages before anything is read. */
  pageCount: number;
  resume: string[];
}

const RECIPES: Record<string, Recipe> = {
  "tmnt-mmpr-iii/issue-3": {
    gitDir: "assets/comics/tmnt-mmpr-iii/issue-3",
    pageCount: 24,
    resume: [
      'Resume at fromStep: "sort-page-elements", once issue-3 has panels (run #88\'s script on it first).',
      "Never run roboflow-page-analyze or get-context on issue-3: they overwrite the reviewed bubble boxes and speakers.",
    ],
  },
  "tmnt-mmpr-iii/issue-4": {
    pageCount: 36,
    resume: ["Run the full pipeline from roboflow-page-analyze."],
  },
};

interface SourceBubble {
  id: string;
  box_2d?: Record<string, unknown>;
  style?: Json;
  ocr_text?: string;
  type?: string;
  speaker?: string;
  emotion?: string;
  side?: string;
  textWithCues?: string;
  characterType?: string;
  voiceDescription?: string;
  aiReasoning?: string;
}

type PlannedWrite =
  | { kind: "raw-upload"; page: number; path: string; buffer: Buffer }
  | {
      kind: "page-image";
      page: number;
      source: string;
      load: () => Promise<Buffer>;
    }
  | { kind: "bubbles-upsert"; rows: ReturnType<typeof toBubbleRow>[] };

function parseArgs() {
  const argv = process.argv.slice(2);
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    const next = i >= 0 ? argv[i + 1] : undefined;
    return next && !next.startsWith("--") ? next : undefined;
  };
  const book = value("--book");
  const issue = value("--issue");
  if (!book || !issue) {
    console.error(
      "Usage: pnpm recover-issue -- --book <book> --issue <issue-N> [--execute] [--skip-pages 1,34-36] [--dump-payload [path]]",
    );
    process.exit(1);
  }
  const recipe = RECIPES[`${book}/${issue}`];
  if (!recipe) {
    console.error(
      `No recovery recipe for ${book}/${issue}. Known: ${Object.keys(RECIPES).join(", ")}`,
    );
    process.exit(1);
  }
  const skip = new Set<number>();
  if (argv.includes("--skip-pages")) {
    const raw = value("--skip-pages");
    const fail = (why: string): never => {
      console.error(`--skip-pages: ${why}`);
      process.exit(1);
    };
    for (const part of (raw ?? fail("needs a value, e.g. 1,34-36")).split(
      ",",
    )) {
      const m =
        /^(\d+)(?:-(\d+))?$/.exec(part) ?? fail(`"${part}" is not N or N-M`);
      const a = Number(m[1]);
      const b = Number(m[2] ?? m[1]);
      if (b < a) fail(`"${part}" runs backwards`);
      if (a < 1 || b > recipe.pageCount) {
        fail(`"${part}" is outside ${issue}'s pages 1-${recipe.pageCount}`);
      }
      for (let n = a; n <= b; n++) skip.add(n);
    }
  }
  const dump = argv.includes("--dump-payload")
    ? (value("--dump-payload") ??
      path.join(os.tmpdir(), `recover-${book}-${issue}-bubbles.json`))
    : undefined;
  return {
    book,
    issue,
    recipe,
    execute: argv.includes("--execute"),
    skip,
    dump,
  };
}

function gitShow(file: string): Buffer {
  return execFileSync("git", ["show", `${GIT_REV}:${file}`], {
    maxBuffer: 64 * 1024 * 1024,
  });
}

function pageNumber(key: string): number {
  const match = /page-0*(\d+)/.exec(key);
  if (!match) throw new Error(`No page number in "${key}"`);
  return Number(match[1]);
}

function toBubbleRow(
  bookId: string,
  issueId: string,
  page: number,
  sortOrder: number,
  b: SourceBubble,
) {
  // cropPath is an absolute local path from the old pipeline; it never reaches the DB.
  const { cropPath: _cropPath, ...box } = b.box_2d ?? {};
  return {
    book_id: bookId,
    issue_id: issueId,
    legacy_id: b.id,
    page_number: page,
    sort_order: sortOrder,
    box_2d: b.box_2d ? (box as Json) : null,
    style: b.style ?? null,
    ocr_text: b.ocr_text ?? null,
    type: b.type ?? "SPEECH",
    speaker: b.speaker ?? null,
    emotion: b.emotion ?? null,
    side: b.side ?? null,
    text_with_cues: b.textWithCues ?? null,
    character_type: b.characterType ?? null,
    voice_description: b.voiceDescription ?? null,
    ai_reasoning: b.aiReasoning ?? null,
    ignored: false,
  };
}

async function planFromGit(
  bookId: string,
  issueId: string,
  gitDir: string,
  skip: Set<number>,
): Promise<PlannedWrite[]> {
  const dims = JSON.parse(gitShow(`${gitDir}/pages.json`).toString()) as Record<
    string,
    { width: number; height: number }
  >;
  const bubbles = JSON.parse(
    gitShow(`${gitDir}/bubbles.json`).toString(),
  ) as Record<string, SourceBubble[]>;

  const writes: PlannedWrite[] = [];
  const mismatches: string[] = [];
  for (const key of Object.keys(dims).sort()) {
    const page = pageNumber(key);
    if (skip.has(page)) continue;
    const file = `pages/page-${String(page).padStart(2, "0")}.jpg`;
    const buffer = gitShow(`${gitDir}/${file}`);
    // storePageImage writes the pages row from the image's own size; it must match pages.json.
    const meta = await sharp(buffer).metadata();
    const want = dims[key]!;
    if (meta.width !== want.width || meta.height !== want.height) {
      mismatches.push(
        `page ${page}: jpg ${meta.width}x${meta.height}, pages.json ${want.width}x${want.height}`,
      );
    }
    writes.push({
      kind: "raw-upload",
      page,
      path: `${bookId}/${issueId}/source/page-${String(page).padStart(2, "0")}.jpg`,
      buffer,
    });
    writes.push({
      kind: "page-image",
      page,
      source: `git ${GIT_REV}:${gitDir}/${file}`,
      load: async () => buffer,
    });
  }
  if (mismatches.length) {
    throw new Error(
      `JPEG size differs from pages.json:\n  ${mismatches.join("\n  ")}`,
    );
  }

  const rows: ReturnType<typeof toBubbleRow>[] = [];
  console.log("Bubbles per page (source JSON / planned rows):");
  for (const [key, list] of Object.entries(bubbles)) {
    const page = pageNumber(key);
    const planned = skip.has(page)
      ? []
      : list.map((b, i) => toBubbleRow(bookId, issueId, page, i, b));
    rows.push(...planned);
    console.log(`  page ${page}: ${list.length} / ${planned.length}`);
  }
  writes.push({ kind: "bubbles-upsert", rows });
  return writes;
}

async function planFromRawStorage(
  bookId: string,
  issueId: string,
  skip: Set<number>,
): Promise<PlannedWrite[]> {
  const folder = `${bookId}/${issueId}/source`;
  const { data, error } = await supabase.storage
    .from(RAW_BUCKET)
    .list(folder, { limit: 1000 });
  if (error) throw new Error(`list ${RAW_BUCKET}/${folder}: ${error.message}`);

  return data
    .filter((f) => /^page-\d+\.jpe?g$/i.test(f.name))
    .map((f) => ({ name: f.name, page: pageNumber(f.name) }))
    .filter((f) => !skip.has(f.page))
    .sort((a, b) => a.page - b.page)
    .map(({ name, page }) => ({
      kind: "page-image" as const,
      page,
      source: `${RAW_BUCKET}/${folder}/${name}`,
      load: async () => {
        const res = await supabase.storage
          .from(RAW_BUCKET)
          .download(`${folder}/${name}`);
        if (res.error)
          throw new Error(`download ${name}: ${res.error.message}`);
        return Buffer.from(await res.data.arrayBuffer());
      },
    }));
}

function describe(w: PlannedWrite, bookId: string, issueId: string): string {
  switch (w.kind) {
    case "raw-upload":
      return `upload ${RAW_BUCKET}/${w.path} (${Math.round(w.buffer.length / 1024)} KB)`;
    case "page-image":
      return `storePageImage comic-pages/${pageStoragePath(bookId, issueId, w.page)} + pages row ${w.page}, from ${w.source}`;
    case "bubbles-upsert":
      return `upsert ${w.rows.length} bubbles rows on (book_id, issue_id, legacy_id)`;
  }
}

async function perform(w: PlannedWrite, bookId: string, issueId: string) {
  switch (w.kind) {
    case "raw-upload": {
      const { error } = await supabase.storage
        .from(RAW_BUCKET)
        .upload(w.path, w.buffer, { contentType: "image/jpeg", upsert: true });
      if (error) throw new Error(`upload ${w.path}: ${error.message}`);
      return;
    }
    case "page-image": {
      const { width, height } = await storePageImage({
        bookId,
        issueId,
        pageNumber: w.page,
        buffer: await w.load(),
      });
      console.log(`    pages row ${w.page}: ${width}x${height}`);
      return;
    }
    case "bubbles-upsert": {
      const { error } = await supabase
        .from("bubbles")
        .upsert(w.rows, { onConflict: "book_id,issue_id,legacy_id" });
      if (error) throw new Error(`bubbles upsert: ${error.message}`);
      return;
    }
  }
}

async function main() {
  const { book, issue, recipe, execute, skip, dump } = parseArgs();

  const { data: row, error } = await selectIssue(
    supabase,
    book,
    issue,
    "status, has_webp",
  ).single();
  if (error) throw new Error(`issues row ${book}/${issue}: ${error.message}`);
  console.log(
    `${book}/${issue}: status=${row.status}, has_webp=${row.has_webp}`,
  );

  const writes = recipe.gitDir
    ? await planFromGit(book, issue, recipe.gitDir, skip)
    : await planFromRawStorage(book, issue, skip);

  const pages = writes.filter((w) => w.kind === "page-image").length;
  const bubbleRows = writes.flatMap((w) =>
    w.kind === "bubbles-upsert" ? w.rows : [],
  );

  console.log(`\nPlanned writes (${execute ? "EXECUTE" : "dry run"}):`);
  for (const w of writes) console.log(`  ${describe(w, book, issue)}`);

  if (dump) {
    fs.writeFileSync(dump, JSON.stringify(bubbleRows, null, 2));
    console.log(`\nBubble payload written to ${dump}`);
  }

  console.log(
    `\n${issue}: ${pages} pages${recipe.gitDir ? `, ${bubbleRows.length} bubbles` : ""}`,
  );

  if (execute) {
    for (const w of writes) {
      console.log(`  ${describe(w, book, issue)}`);
      await perform(w, book, issue);
    }
    console.log("Done. issues row untouched, has_webp not set.");
  } else {
    console.log("Dry run: nothing written. Pass --execute to perform.");
  }

  console.log(`\nResume ${issue}:`);
  for (const line of recipe.resume) console.log(`  ${line}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

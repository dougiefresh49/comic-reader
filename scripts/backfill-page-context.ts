#!/usr/bin/env node

/**
 * One-time chore: walk every issue's local data/gemini-context/page-NN-gemini-context.json
 * and upsert into the public.page_context DB table.
 *
 * The original ingest's get-context step is supposed to write to this table,
 * but it didn't run (or didn't write) for the 3 existing issues. The cached
 * local files have the same data — this script just syncs them.
 *
 * Usage: pnpm backfill-page-context
 *        pnpm backfill-page-context -- --book tmnt-mmpr-iii --issue 1
 */

import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";
import { supabase } from "./lib/supabase.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, "..");
const COMICS_DIR = path.join(PROJECT_ROOT, "assets", "comics");

interface Args {
  book?: string;
  issue?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let book: string | undefined;
  let issue: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--book") book = argv[++i];
    else if (argv[i] === "--issue") {
      const v = argv[++i];
      if (v) issue = v.startsWith("issue-") ? v : `issue-${v}`;
    }
  }
  return { book, issue };
}

async function listBooks(): Promise<string[]> {
  if (!(await fs.pathExists(COMICS_DIR))) return [];
  const entries = await fs.readdir(COMICS_DIR, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

async function listIssues(book: string): Promise<string[]> {
  const bookDir = path.join(COMICS_DIR, book);
  if (!(await fs.pathExists(bookDir))) return [];
  const entries = await fs.readdir(bookDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && e.name.startsWith("issue-"))
    .map((e) => e.name);
}

async function backfillIssue(
  book: string,
  issue: string,
): Promise<{
  upserted: number;
  failed: number;
}> {
  const ctxDir = path.join(COMICS_DIR, book, issue, "data", "gemini-context");
  if (!(await fs.pathExists(ctxDir))) {
    console.log(`   ${book}/${issue}: no gemini-context dir, skipping`);
    return { upserted: 0, failed: 0 };
  }
  const files = (await fs.readdir(ctxDir))
    .filter((f) => /^page-\d+-gemini-context\.json$/.test(f))
    .sort();

  let upserted = 0;
  let failed = 0;

  for (const filename of files) {
    const m = /^page-(\d+)-gemini-context\.json$/.exec(filename);
    if (!m) continue;
    const pageNumber = parseInt(m[1]!, 10);
    const raw = await fs.readJson(path.join(ctxDir, filename));

    const { error } = await supabase.from("page_context").upsert(
      {
        book_id: book,
        issue_id: issue,
        page_number: pageNumber,
        gemini_model: "gemini-3.1-pro-preview", // historical: get-context used HIGH
        raw_response: raw,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "book_id,issue_id,page_number" },
    );

    if (error) {
      console.warn(
        `   ${book}/${issue}/page-${String(pageNumber).padStart(2, "0")}: ${error.message}`,
      );
      failed++;
    } else {
      upserted++;
    }
  }

  console.log(
    `   ${book}/${issue}: ${upserted} page(s) upserted${failed > 0 ? `, ${failed} failed` : ""}`,
  );
  return { upserted, failed };
}

async function main() {
  const { book, issue } = parseArgs();

  let issuesToDo: Array<{ book: string; issue: string }> = [];

  if (book && issue) {
    issuesToDo = [{ book, issue }];
  } else if (book) {
    issuesToDo = (await listIssues(book)).map((iss) => ({ book, issue: iss }));
  } else {
    for (const b of await listBooks()) {
      for (const iss of await listIssues(b)) {
        issuesToDo.push({ book: b, issue: iss });
      }
    }
  }

  if (issuesToDo.length === 0) {
    console.log("No issues found to backfill.");
    return;
  }

  console.log(
    `Backfilling page_context for ${issuesToDo.length} issue(s)...\n`,
  );
  let totalUpserted = 0;
  let totalFailed = 0;
  for (const { book: b, issue: i } of issuesToDo) {
    const r = await backfillIssue(b, i);
    totalUpserted += r.upserted;
    totalFailed += r.failed;
  }

  console.log(
    `\n✓ Done: ${totalUpserted} pages upserted, ${totalFailed} failed`,
  );
}

main().catch((err: unknown) => {
  console.error("❌", err);
  process.exit(1);
});

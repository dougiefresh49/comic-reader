#!/usr/bin/env node
/**
 * Upload local raw page JPEGs to the comic-pages-raw Supabase Storage bucket
 * and upsert the issue/book rows in the DB.
 *
 * Usage: pnpm upload-source-pages -- --book <name> --issue <n> [--force]
 */

import fs from "fs-extra";
import path from "path";
import pLimit from "p-limit";
import { fileURLToPath } from "url";
import { supabase } from "./lib/supabase.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, "..");

const RAW_BUCKET = "comic-pages-raw";

interface Args {
  book: string;
  issue: string;
  force: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let book = "";
  let issue = "";
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--book") book = argv[++i] ?? "";
    else if (a === "--issue") issue = argv[++i] ?? "";
    else if (a === "--force") force = true;
  }
  if (!book || !issue) {
    console.error(
      "Usage: pnpm upload-source-pages -- --book <name> --issue <n> [--force]",
    );
    process.exit(1);
  }
  return { book, issue, force };
}

async function main() {
  const { book, issue, force } = parseArgs();
  const issueId = `issue-${issue}`;

  const sourceDir = path.join(
    PROJECT_ROOT,
    "assets",
    "comics",
    book,
    issueId,
    "pages",
  );
  if (!fs.existsSync(sourceDir)) {
    console.error(`Source dir not found: ${sourceDir}`);
    process.exit(1);
  }

  const files = (await fs.readdir(sourceDir))
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    .sort();
  if (files.length === 0) {
    console.error(`No image files in ${sourceDir}`);
    process.exit(1);
  }

  console.log(`Found ${files.length} pages to process`);

  // Step 1: ensure book + issue rows exist
  const sourcePath = `${book}/${issueId}/source/`;
  const { error: bErr } = await supabase
    .from("books")
    .upsert({ id: book, slug: book, name: book }, { onConflict: "id" });
  if (bErr && !bErr.message.includes("duplicate")) {
    console.warn(`books upsert: ${bErr.message}`);
  }
  const { error: iErr } = await supabase.from("issues").upsert(
    {
      id: issueId,
      book_id: book,
      number: parseInt(issue, 10),
      name: `Issue ${issue}`,
      status: "pending",
      source_pages_path: sourcePath,
    },
    { onConflict: "book_id,id" },
  );
  if (iErr) {
    console.error(`issues upsert: ${iErr.message}`);
    process.exit(1);
  }

  // Step 2: list existing files in bucket (skip those, unless --force)
  const { data: existing } = await supabase.storage
    .from(RAW_BUCKET)
    .list(sourcePath.replace(/\/$/, ""), { limit: 1000 });
  const existingNames = new Set((existing ?? []).map((e) => e.name));

  // Step 3: upload (parallel, limit 8)
  const limit = pLimit(8);
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  await Promise.all(
    files.map((filename) =>
      limit(async () => {
        if (!force && existingNames.has(filename)) {
          skipped++;
          return;
        }
        const localPath = path.join(sourceDir, filename);
        const buf = await fs.readFile(localPath);
        const remotePath = `${sourcePath}${filename}`;
        const { error } = await supabase.storage
          .from(RAW_BUCKET)
          .upload(remotePath, buf, {
            contentType: "image/jpeg",
            upsert: true,
          });
        if (error) {
          failed++;
          console.warn(`  ✗ ${filename}: ${error.message}`);
        } else {
          uploaded++;
        }
      }),
    ),
  );

  console.log(
    `\n✓ Uploaded: ${uploaded}  ·  Skipped (existing): ${skipped}  ·  Failed: ${failed}`,
  );
  console.log(`Bucket path: ${RAW_BUCKET}/${sourcePath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

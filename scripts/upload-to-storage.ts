#!/usr/bin/env node
// Upload existing assets to Supabase Storage buckets.
//
// Usage: pnpm upload-to-storage -- --book tmnt-mmpr-iii --issue 1
//        pnpm upload-to-storage -- --all
//        pnpm upload-to-storage -- --book tmnt-mmpr-iii --issue 1 --force   (re-upload even if exists)
//        pnpm upload-to-storage -- --book tmnt-mmpr-iii --issue 1 --skip-crops
//
// Uploads:
//   public/comics/{book}/{issue}/pages/*.webp  → comic-pages bucket
//   public/comics/{book}/{issue}/audio/*.mp3   → comic-audio bucket
//   assets/comics/{book}/{issue}/data/ocr-crops/**/*.jpg → comic-ocr-crops bucket (converted to WebP)
//     Also updates bubbles.crop_storage_path in DB.

import { createClient } from "@supabase/supabase-js";
import fs from "fs-extra";
import path, { join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";
import pLimit from "p-limit";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");

const CONCURRENCY = 8;

// ── Supabase ────────────────────────────────────────────────────────────────
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
});

// ── Args ────────────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const bookIdx = args.indexOf("--book");
  const issueIdx = args.indexOf("--issue");
  return {
    book: bookIdx >= 0 ? args[bookIdx + 1] : undefined,
    issue: issueIdx >= 0 ? args[issueIdx + 1] : undefined,
    all: args.includes("--all"),
    force: args.includes("--force"),
    skipCrops: args.includes("--skip-crops"),
  };
}

// ── Upload helper ───────────────────────────────────────────────────────────
interface UploadResult {
  uploaded: number;
  skipped: number;
  failed: number;
}

async function uploadFile(
  bucket: string,
  storagePath: string,
  data: Buffer,
  contentType: string,
  force: boolean,
): Promise<"uploaded" | "skipped" | "failed"> {
  if (!force) {
    // Check if already exists
    const { data: existing } = await supabase.storage
      .from(bucket)
      .list(path.dirname(storagePath), {
        search: path.basename(storagePath),
        limit: 1,
      });
    if (existing && existing.length > 0) return "skipped";
  }

  const { error } = await supabase.storage
    .from(bucket)
    .upload(storagePath, data, { contentType, upsert: force });

  if (error) {
    // "already exists" is not a real error unless force=true
    if (!force && error.message?.includes("already exists")) return "skipped";
    console.warn(`  ✗ ${bucket}/${storagePath}: ${error.message}`);
    return "failed";
  }
  return "uploaded";
}

// ── Pages (WebP) ────────────────────────────────────────────────────────────
async function uploadPages(
  bookId: string,
  issueId: string,
  force: boolean,
): Promise<UploadResult> {
  const pagesDir = join(ROOT, "public", "comics", bookId, issueId, "pages");
  if (!fs.existsSync(pagesDir)) {
    console.log(`    ⚠ No pages dir at ${pagesDir} — skipping`);
    return { uploaded: 0, skipped: 0, failed: 0 };
  }

  const files = fs.readdirSync(pagesDir).filter((f) => f.endsWith(".webp"));
  const limit = pLimit(CONCURRENCY);
  const result: UploadResult = { uploaded: 0, skipped: 0, failed: 0 };

  await Promise.all(
    files.map((file) =>
      limit(async () => {
        const storagePath = `${bookId}/${issueId}/${file}`;
        const data = fs.readFileSync(join(pagesDir, file));
        const status = await uploadFile(
          "comic-pages",
          storagePath,
          data,
          "image/webp",
          force,
        );
        result[status]++;
      }),
    ),
  );

  return result;
}

// ── Audio (MP3) ─────────────────────────────────────────────────────────────
async function uploadAudio(
  bookId: string,
  issueId: string,
  force: boolean,
): Promise<UploadResult> {
  const audioDir = join(ROOT, "public", "comics", bookId, issueId, "audio");
  if (!fs.existsSync(audioDir)) {
    console.log(`    ⚠ No audio dir — skipping`);
    return { uploaded: 0, skipped: 0, failed: 0 };
  }

  const files = fs.readdirSync(audioDir).filter((f) => f.endsWith(".mp3"));
  const limit = pLimit(CONCURRENCY);
  const result: UploadResult = { uploaded: 0, skipped: 0, failed: 0 };

  await Promise.all(
    files.map((file) =>
      limit(async () => {
        const storagePath = `${bookId}/${issueId}/${file}`;
        const data = fs.readFileSync(join(audioDir, file));
        const status = await uploadFile(
          "comic-audio",
          storagePath,
          data,
          "audio/mpeg",
          force,
        );
        result[status]++;
      }),
    ),
  );

  return result;
}

// ── OCR Crops ───────────────────────────────────────────────────────────────
interface BubbleRaw {
  id: string;
  box_2d?: { cropPath?: string };
}

async function uploadOcrCrops(
  bookId: string,
  issueId: string,
  issueDir: string,
  force: boolean,
): Promise<UploadResult & { dbUpdated: number }> {
  const cropsBaseDir = join(issueDir, "data", "ocr-crops");
  if (!fs.existsSync(cropsBaseDir)) {
    console.log(`    ⚠ No ocr-crops dir — skipping`);
    return { uploaded: 0, skipped: 0, failed: 0, dbUpdated: 0 };
  }

  // Build map: absolute cropPath → legacyBubbleId
  const bubblesPath = join(issueDir, "bubbles.json");
  const cropPathToLegacyId = new Map<string, string>();

  if (fs.existsSync(bubblesPath)) {
    const bubblesData = fs.readJsonSync(bubblesPath) as Record<
      string,
      BubbleRaw[]
    >;
    for (const bubbles of Object.values(bubblesData)) {
      for (const bubble of bubbles) {
        if (bubble.box_2d?.cropPath) {
          cropPathToLegacyId.set(
            path.resolve(bubble.box_2d.cropPath),
            bubble.id,
          );
        }
      }
    }
  }

  // Collect all .jpg files under cropsBaseDir
  const cropFiles: string[] = [];
  const pageDirs = fs
    .readdirSync(cropsBaseDir)
    .filter((d) => fs.statSync(join(cropsBaseDir, d)).isDirectory());

  for (const pageDir of pageDirs) {
    const jpgs = fs
      .readdirSync(join(cropsBaseDir, pageDir))
      .filter((f) => f.endsWith(".jpg"))
      .map((f) => join(cropsBaseDir, pageDir, f));
    cropFiles.push(...jpgs);
  }

  const limit = pLimit(CONCURRENCY);
  const result = { uploaded: 0, skipped: 0, failed: 0, dbUpdated: 0 };

  // DB updates batched to avoid individual round-trips
  const dbUpdates: { legacyId: string; storagePath: string }[] = [];

  await Promise.all(
    cropFiles.map((cropFilePath) =>
      limit(async () => {
        const absPath = path.resolve(cropFilePath);
        const legacyId = cropPathToLegacyId.get(absPath);

        // Derive storage path: {bookId}/{issueId}/page-{NN}/{legacyId}.webp
        // If legacyId unknown, fall back to the original filename stem
        const pageFolder = path.basename(path.dirname(cropFilePath)); // "page-05"
        const stem = legacyId ?? basename(cropFilePath, ".jpg");
        const storagePath = `${bookId}/${issueId}/${pageFolder}/${stem}.webp`;

        // Convert JPEG → WebP, max 800px
        let webpBuffer: Buffer;
        try {
          webpBuffer = await sharp(cropFilePath)
            .resize({
              width: 800,
              height: 800,
              fit: "inside",
              withoutEnlargement: true,
            })
            .webp({ quality: 85 })
            .toBuffer();
        } catch (err) {
          console.warn(
            `    ✗ sharp convert failed for ${cropFilePath}: ${err}`,
          );
          result.failed++;
          return;
        }

        const status = await uploadFile(
          "comic-ocr-crops",
          storagePath,
          webpBuffer,
          "image/webp",
          force,
        );
        result[status]++;

        if (status === "uploaded" && legacyId) {
          dbUpdates.push({ legacyId, storagePath });
        }
      }),
    ),
  );

  // Batch-update crop_storage_path in DB
  if (dbUpdates.length > 0) {
    await Promise.all(
      dbUpdates.map(({ legacyId, storagePath }) =>
        supabase
          .from("bubbles")
          .update({ crop_storage_path: storagePath })
          .eq("book_id", bookId)
          .eq("issue_id", issueId)
          .eq("legacy_id", legacyId),
      ),
    );
    result.dbUpdated = dbUpdates.length;
  }

  return result;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function processIssue(
  bookId: string,
  issueId: string,
  force: boolean,
  skipCrops: boolean,
): Promise<void> {
  const issueDir = join(ROOT, "assets", "comics", bookId, issueId);
  console.log(`\n  📖 ${bookId}/${issueId}`);

  const pages = await uploadPages(bookId, issueId, force);
  console.log(
    `    pages    → ${pages.uploaded} uploaded, ${pages.skipped} skipped, ${pages.failed} failed`,
  );

  const audio = await uploadAudio(bookId, issueId, force);
  console.log(
    `    audio    → ${audio.uploaded} uploaded, ${audio.skipped} skipped, ${audio.failed} failed`,
  );

  if (!skipCrops) {
    const crops = await uploadOcrCrops(bookId, issueId, issueDir, force);
    console.log(
      `    crops    → ${crops.uploaded} uploaded, ${crops.skipped} skipped, ${crops.failed} failed (${crops.dbUpdated} DB rows updated)`,
    );
  }
}

async function main(): Promise<void> {
  const { book, issue, all, force, skipCrops } = parseArgs();

  if (!all && !book) {
    console.error(
      "Usage: pnpm upload-to-storage -- --book <name> [--issue <n>] [--all] [--force] [--skip-crops]",
    );
    process.exit(1);
  }

  if (force) console.log("⚠  --force: will overwrite existing files");

  const comicsDir = join(ROOT, "assets", "comics");
  const books = all
    ? fs
        .readdirSync(comicsDir)
        .filter((d) => fs.statSync(join(comicsDir, d)).isDirectory())
    : [book!];

  for (const bookId of books) {
    const bookDir = join(comicsDir, bookId);
    const issueDirs = fs
      .readdirSync(bookDir)
      .filter(
        (d) =>
          d.startsWith("issue-") && fs.statSync(join(bookDir, d)).isDirectory(),
      );

    const filteredIssues =
      issue && !all
        ? issueDirs.filter((d) => d === `issue-${issue}`)
        : issueDirs;

    for (const issueDirName of filteredIssues) {
      await processIssue(bookId, issueDirName, force, skipCrops);
    }
  }

  console.log("\n✅ Upload complete\n");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

#!/usr/bin/env node

/**
 * Scan assets directory structure and sync book/issue metadata to the database
 */

import fs from "fs-extra";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { supabase } from "./lib/supabase.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

/**
 * Get issue statistics (same as previous manifest: assets-based counts)
 */
async function getIssueStats(issuePath: string, issueId: string) {
  const pagesWebpDir = join(issuePath, "pages-webp");
  const audioDir = join(issuePath, "audio");
  const bubblesFile = join(issuePath, "bubbles.json");
  const timestampsFile = join(issuePath, "audio-timestamps.json");

  let pageCount = 0;
  let hasWebP = false;
  if (await fs.pathExists(pagesWebpDir)) {
    const files = await fs.readdir(pagesWebpDir);
    pageCount = files.filter((f) => f.endsWith(".webp")).length;
    hasWebP = pageCount > 0;
  }

  let audioCount = 0;
  let hasAudio = false;
  if (await fs.pathExists(audioDir)) {
    const files = await fs.readdir(audioDir);
    audioCount = files.filter((f) => f.endsWith(".mp3")).length;
    hasAudio = audioCount > 0;
  }

  let bubbleCount = 0;
  if (await fs.pathExists(bubblesFile)) {
    try {
      const cache = JSON.parse(
        await fs.readFile(bubblesFile, "utf-8"),
      ) as Record<string, unknown[]>;
      bubbleCount = Object.values(cache).reduce(
        (sum, bubbles) => sum + bubbles.length,
        0,
      );
    } catch (error) {
      console.warn(
        `   ⚠️  Could not read bubbles.json for ${issueId}: ${error}`,
      );
    }
  }

  const hasTimestamps = await fs.pathExists(timestampsFile);
  const issueNumber = issueId.replace("issue-", "");
  return {
    pageCount,
    bubbleCount,
    audioCount,
    hasWebP,
    hasAudio,
    hasTimestamps,
    name: `Issue ${issueNumber}`,
  };
}

async function bookTitleFromConfig(bookPath: string, bookId: string) {
  const configPath = join(bookPath, "book-config.json");
  if (await fs.pathExists(configPath)) {
    const cfg = (await fs.readJson(configPath)) as { title?: string };
    if (cfg.title) return cfg.title;
  }
  return bookId
    .split("-")
    .map((word) => word.toUpperCase())
    .join(" ");
}

/**
 * Parse command-line arguments
 */
function parseArgs(): void {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage: pnpm run generate-manifest [options]

Scans assets/comics and updates the books and issues tables in the database.

Options:
  --help, -h                  Show this help message
`);
    process.exit(0);
  }
}

/**
 * Main execution
 */
async function main() {
  try {
    console.log("📋 Syncing content manifest to database...\n");
    parseArgs();
    const ASSETS_COMICS_DIR = join(PROJECT_ROOT, "assets", "comics");

    console.log(`📖 Scanning: ${ASSETS_COMICS_DIR}`);
    console.log();

    if (!(await fs.pathExists(ASSETS_COMICS_DIR))) {
      console.error(`❌ Comics directory not found: ${ASSETS_COMICS_DIR}`);
      process.exit(1);
    }

    let bookCount = 0;
    let totalIssues = 0;
    let totalPages = 0;

    const bookDirs = await fs.readdir(ASSETS_COMICS_DIR, {
      withFileTypes: true,
    });

    for (const bookDir of bookDirs) {
      if (!bookDir.isDirectory()) continue;

      const bookId = bookDir.name;
      const bookPath = join(ASSETS_COMICS_DIR, bookId);

      console.log(`📚 Processing book: ${bookId}...`);
      const bookName = await bookTitleFromConfig(bookPath, bookId);
      const { error: bookError } = await supabase
        .from("books")
        .upsert(
          { id: bookId, name: bookName, slug: bookId },
          { onConflict: "id" },
        );
      if (bookError) {
        throw new Error(`books upsert (${bookId}): ${bookError.message}`);
      }

      const issueDirs = await fs.readdir(bookPath, { withFileTypes: true });
      let issuesThisBook = 0;

      for (const issueDir of issueDirs) {
        if (!issueDir.isDirectory()) continue;
        const issueId = issueDir.name;
        if (!issueId.startsWith("issue-")) continue;
        const issuePath = join(bookPath, issueId);
        console.log(`   📄 Processing ${issueId}...`);
        const stats = await getIssueStats(issuePath, issueId);
        const num = parseInt(issueId.replace("issue-", "") || "0", 10);
        const { error: issErr } = await supabase.from("issues").upsert(
          {
            id: issueId,
            book_id: bookId,
            number: num,
            name: stats.name,
            page_count: stats.pageCount,
            bubble_count: stats.bubbleCount,
            audio_count: stats.audioCount,
            has_webp: stats.hasWebP,
            has_audio: stats.hasAudio,
            has_timestamps: stats.hasTimestamps,
          },
          { onConflict: "book_id,id" },
        );
        if (issErr) {
          throw new Error(
            `issues upsert (${bookId}/${issueId}): ${issErr.message}`,
          );
        }
        totalIssues += 1;
        totalPages += stats.pageCount;
        issuesThisBook += 1;
        console.log(
          `      ✓ ${stats.pageCount} pages, ${stats.bubbleCount} bubbles, ${stats.audioCount} audio files`,
        );
      }

      if (issuesThisBook > 0) bookCount += 1;
      console.log();
    }

    // Summary
    console.log("📊 Summary:");
    console.log(`   Books: ${bookCount}`);
    console.log(`   Total issues: ${totalIssues}`);
    console.log(`   Total pages: ${totalPages}`);
    console.log(`\n✅ Manifest sync complete!`);
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

main();

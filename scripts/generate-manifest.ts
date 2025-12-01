#!/usr/bin/env node

/**
 * Generate manifest file listing all available books and issues
 *
 * Scans the assets directory structure and creates a manifest.json file
 * that the Next.js app can use to discover available content.
 */

import fs from "fs-extra";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

interface IssueManifest {
  id: string;
  name: string;
  pageCount: number;
  bubbleCount: number;
  audioCount: number;
  hasWebP: boolean;
  hasAudio: boolean;
  hasTimestamps: boolean;
}

interface BookManifest {
  id: string;
  name: string;
  issues: IssueManifest[];
}

interface Manifest {
  books: BookManifest[];
  generatedAt: string;
}

/**
 * Parse command-line arguments
 */
function parseArgs(): { jsonOnly?: boolean; tsOnly?: boolean } {
  const args = process.argv.slice(2);

  // Check for help flag
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage: npm run generate-manifest [options]

Options:
  --json-only                 Generate only JSON file (default: generates both JSON and TypeScript)
  --ts-only                   Generate only TypeScript file
  --help, -h                  Show this help message

Examples:
  npm run generate-manifest                    Generate both JSON and TypeScript
  npm run generate-manifest --json-only       Generate only JSON file
  npm run generate-manifest --ts-only         Generate only TypeScript file
`);
    process.exit(0);
  }

  let jsonOnly = false;
  let tsOnly = false;

  for (const arg of args) {
    if (arg === "--json-only") {
      jsonOnly = true;
    }
    if (arg === "--ts-only") {
      tsOnly = true;
    }
  }

  return { jsonOnly, tsOnly };
}

/**
 * Get issue statistics
 */
async function getIssueStats(
  issuePath: string,
  issueId: string,
): Promise<IssueManifest> {
  const pagesWebpDir = join(issuePath, "pages-webp");
  const audioDir = join(issuePath, "audio");
  const contextCacheFile = join(issuePath, "context-cache.json");
  const timestampsFile = join(issuePath, "audio-timestamps.json");

  // Count WebP pages
  let pageCount = 0;
  let hasWebP = false;
  if (await fs.pathExists(pagesWebpDir)) {
    const files = await fs.readdir(pagesWebpDir);
    pageCount = files.filter((f) => f.endsWith(".webp")).length;
    hasWebP = pageCount > 0;
  }

  // Count audio files
  let audioCount = 0;
  let hasAudio = false;
  if (await fs.pathExists(audioDir)) {
    const files = await fs.readdir(audioDir);
    audioCount = files.filter((f) => f.endsWith(".mp3")).length;
    hasAudio = audioCount > 0;
  }

  // Count bubbles from context-cache
  let bubbleCount = 0;
  if (await fs.pathExists(contextCacheFile)) {
    try {
      const cache = JSON.parse(
        await fs.readFile(contextCacheFile, "utf-8"),
      ) as Record<string, unknown[]>;
      bubbleCount = Object.values(cache).reduce(
        (sum, bubbles) => sum + bubbles.length,
        0,
      );
    } catch (error) {
      console.warn(
        `   ⚠️  Could not read context-cache.json for ${issueId}: ${error}`,
      );
    }
  }

  // Check for timestamps
  const hasTimestamps = await fs.pathExists(timestampsFile);

  // Extract issue number from ID (e.g., "issue-1" -> "1")
  const issueNumber = issueId.replace("issue-", "");

  return {
    id: issueId,
    name: `Issue ${issueNumber}`,
    pageCount,
    bubbleCount,
    audioCount,
    hasWebP,
    hasAudio,
    hasTimestamps,
  };
}

/**
 * Main execution
 */
async function main() {
  try {
    console.log("📋 Generating content manifest...\n");

    // Parse arguments
    const { jsonOnly, tsOnly } = parseArgs();

    // Set up paths
    const ASSETS_COMICS_DIR = join(
      PROJECT_ROOT,
      "assets",
      "comics",
    );
    const JSON_OUTPUT = join(
      PROJECT_ROOT,
      "public",
      "comics",
      "manifest.json",
    );
    const TS_OUTPUT = join(
      PROJECT_ROOT,
      "src",
      "data",
      "manifest.ts",
    );

    console.log(`📖 Scanning: ${ASSETS_COMICS_DIR}`);
    if (!tsOnly) {
      console.log(`💾 JSON Output: ${JSON_OUTPUT}`);
    }
    if (!jsonOnly) {
      console.log(`💾 TypeScript Output: ${TS_OUTPUT}`);
    }
    console.log();

    // Check if assets directory exists
    if (!(await fs.pathExists(ASSETS_COMICS_DIR))) {
      console.error(`❌ Comics directory not found: ${ASSETS_COMICS_DIR}`);
      process.exit(1);
    }

    // Scan for books
    const books: BookManifest[] = [];
    const bookDirs = await fs.readdir(ASSETS_COMICS_DIR, {
      withFileTypes: true,
    });

    for (const bookDir of bookDirs) {
      if (!bookDir.isDirectory()) continue;

      const bookId = bookDir.name;
      const bookPath = join(ASSETS_COMICS_DIR, bookId);

      console.log(`📚 Processing book: ${bookId}...`);

      // Scan for issues
      const issueDirs = await fs.readdir(bookPath, { withFileTypes: true });
      const issues: IssueManifest[] = [];

      for (const issueDir of issueDirs) {
        if (!issueDir.isDirectory()) continue;

        const issueId = issueDir.name;
        if (!issueId.startsWith("issue-")) continue;

        const issuePath = join(bookPath, issueId);
        console.log(`   📄 Processing ${issueId}...`);

        const issueStats = await getIssueStats(issuePath, issueId);
        issues.push(issueStats);

        console.log(
          `      ✓ ${issueStats.pageCount} pages, ${issueStats.bubbleCount} bubbles, ${issueStats.audioCount} audio files`,
        );
      }

      if (issues.length > 0) {
        // Format book name (e.g., "tmnt-mmpr-iii" -> "TMNT x MMPR III")
        const bookName = bookId
          .split("-")
          .map((word) => word.toUpperCase())
          .join(" ");

        books.push({
          id: bookId,
          name: bookName,
          issues: issues.sort((a, b) => {
            // Sort issues by number
            const aNum = parseInt(a.id.replace("issue-", ""), 10);
            const bNum = parseInt(b.id.replace("issue-", ""), 10);
            return aNum - bNum;
          }),
        });
      }

      console.log();
    }

    // Create manifest
    const manifest: Manifest = {
      books,
      generatedAt: new Date().toISOString(),
    };

    // Write JSON file (if not ts-only)
    if (!tsOnly) {
      await fs.ensureDir(dirname(JSON_OUTPUT));
      await fs.writeFile(JSON_OUTPUT, JSON.stringify(manifest, null, 2));
      console.log(`✅ JSON manifest: ${JSON_OUTPUT}`);
    }

    // Write TypeScript file (if not json-only)
    if (!jsonOnly) {
      await fs.ensureDir(dirname(TS_OUTPUT));

      // Generate TypeScript file with types
      const tsContent = `/**
 * Comic content manifest
 * 
 * This file is auto-generated by scripts/generate-manifest.ts
 * Do not edit manually - regenerate using: npm run generate-manifest
 */

export interface IssueManifest {
  id: string;
  name: string;
  pageCount: number;
  bubbleCount: number;
  audioCount: number;
  hasWebP: boolean;
  hasAudio: boolean;
  hasTimestamps: boolean;
}

export interface BookManifest {
  id: string;
  name: string;
  issues: IssueManifest[];
}

export interface Manifest {
  books: BookManifest[];
  generatedAt: string;
}

export const manifest: Manifest = ${JSON.stringify(manifest, null, 2)} as const;

export default manifest;
`;

      await fs.writeFile(TS_OUTPUT, tsContent);
      console.log(`✅ TypeScript manifest: ${TS_OUTPUT}`);
    }

    // Summary
    console.log("\n📊 Summary:");
    console.log(`   Books: ${books.length}`);
    const totalIssues = books.reduce((sum, book) => sum + book.issues.length, 0);
    console.log(`   Total issues: ${totalIssues}`);
    const totalPages = books.reduce(
      (sum, book) =>
        sum + book.issues.reduce((s, issue) => s + issue.pageCount, 0),
      0,
    );
    console.log(`   Total pages: ${totalPages}`);
    console.log(`\n✅ Manifest generation complete!`);
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

main();


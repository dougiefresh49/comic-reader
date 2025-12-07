#!/usr/bin/env node

/**
 * Sort bubbles in bubbles.json by their position on the page
 *
 * Sorts bubbles by:
 * 1. Y-coordinate (top to bottom)
 * 2. X-coordinate (left to right) for bubbles at similar Y positions
 *
 * This ensures bubbles are in reading order (top-to-bottom, left-to-right)
 */

import fs from "fs-extra";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { Bubble } from "./utils/gemini-context.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

type ContextCache = Record<string, Bubble[]>;

/**
 * Parse command-line arguments
 */
function parseArgs(): { issue: string; dryRun?: boolean } {
  const args = process.argv.slice(2);

  // Check for help flag
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage: npm run sort-bubbles [options]

Options:
  --issue=N, --issue N        Issue number (e.g., --issue=2 for issue-2, default: issue-2)
  --dry-run                   Show what would be sorted without making changes
  --help, -h                  Show this help message

Examples:
  npm run sort-bubbles                    Sort bubbles for issue-2
  npm run sort-bubbles --issue=1         Sort bubbles for issue-1
  npm run sort-bubbles --dry-run         Preview sorting without saving
`);
    process.exit(0);
  }

  let issue = "issue-2";
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    if (arg.startsWith("--issue=")) {
      const issueNum = arg.split("=")[1]?.trim();
      if (issueNum) {
        issue = issueNum.startsWith("issue-") ? issueNum : `issue-${issueNum}`;
      }
    }
    if (arg === "--issue") {
      const nextArg = args[i + 1];
      if (nextArg) {
        const issueNum = nextArg.trim();
        issue = issueNum.startsWith("issue-") ? issueNum : `issue-${issueNum}`;
      }
    }
    if (arg === "--dry-run") {
      dryRun = true;
    }
  }

  return { issue, dryRun };
}

/**
 * Sort bubbles by position (top-to-bottom, left-to-right)
 */
function sortBubblesByPosition(bubbles: Bubble[]): Bubble[] {
  return [...bubbles].sort((a, b) => {
    const aY = a.box_2d.y ?? 0;
    const bY = b.box_2d.y ?? 0;
    const aX = a.box_2d.x ?? 0;
    const bX = b.box_2d.x ?? 0;

    // First sort by Y (top to bottom)
    // Use a tolerance to group bubbles that are roughly on the same row
    const yTolerance = 50; // pixels - bubbles within 50px vertically are considered same row
    const yDiff = Math.abs(aY - bY);

    if (yDiff > yTolerance) {
      return aY - bY;
    }

    // If Y is similar (same row), sort by X (left to right)
    return aX - bX;
  });
}

/**
 * Main execution
 */
async function main() {
  try {
    console.log("🔄 Starting bubble sorting...\n");

    // Parse arguments
    const { issue, dryRun } = parseArgs();

    // Set up paths
    const COMIC_DIR = join(PROJECT_ROOT, "assets", "comics", "tmnt-mmpr-iii");
    const ISSUE_DIR = join(COMIC_DIR, issue);
    const CACHE_FILE = join(ISSUE_DIR, "bubbles.json");

    console.log(`📁 Issue: ${issue}`);
    console.log(`📖 Cache: ${CACHE_FILE}`);
    if (dryRun) {
      console.log(`🔍 Dry run mode - no changes will be saved\n`);
    } else {
      console.log();
    }

    // Load context cache
    console.log("📖 Loading context cache...");
    let cache: ContextCache = {};
    try {
      const existing = await fs.readFile(CACHE_FILE, "utf-8");
      cache = JSON.parse(existing) as ContextCache;
      console.log(
        `   ✓ Loaded cache with ${Object.keys(cache).length} pages\n`,
      );
    } catch (error) {
      console.error(`❌ Failed to load context cache: ${error}`);
      console.error(`   Cache file: ${CACHE_FILE}`);
      process.exit(1);
    }

    // Sort bubbles for each page
    console.log("🔀 Sorting bubbles by position...\n");
    const sortedCache: ContextCache = {};
    let totalBubbles = 0;
    let totalReordered = 0;

    for (const [pageName, bubbles] of Object.entries(cache)) {
      const originalOrder = bubbles.map((b, i) => ({
        id: b.id,
        index: i,
        x: b.box_2d.x ?? 0,
        y: b.box_2d.y ?? 0,
      }));

      const sortedBubbles = sortBubblesByPosition(bubbles);
      sortedCache[pageName] = sortedBubbles;

      // Check if order changed
      const orderChanged = sortedBubbles.some(
        (b, i) => b.id !== bubbles[i]?.id,
      );

      if (orderChanged) {
        totalReordered++;
        console.log(`📄 ${pageName}:`);
        console.log(
          `   Original order: ${bubbles.map((b) => b.id).join(", ")}`,
        );
        console.log(
          `   Sorted order:   ${sortedBubbles.map((b) => b.id).join(", ")}`,
        );
        console.log();
      }

      totalBubbles += bubbles.length;
    }

    // Summary
    console.log("📊 Summary:");
    console.log(`   Total pages: ${Object.keys(cache).length}`);
    console.log(`   Total bubbles: ${totalBubbles}`);
    console.log(`   Pages reordered: ${totalReordered}`);

    // Save if not dry run
    if (!dryRun) {
      console.log("\n💾 Saving sorted context cache...");
      await fs.writeFile(CACHE_FILE, JSON.stringify(sortedCache, null, 2));
      console.log(`   ✓ Saved to ${CACHE_FILE}\n`);
      console.log("✅ Bubble sorting complete!");
    } else {
      console.log("\n🔍 Dry run complete - no changes were saved");
      console.log("   Run without --dry-run to apply changes");
    }
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

main();

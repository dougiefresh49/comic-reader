#!/usr/bin/env node

/**
 * Add percentage-based style objects to bubbles in bubbles.json
 *
 * Calculates percentage-based positioning (left, top, width, height) for each bubble
 * based on the original page dimensions from pages.json. This allows bubbles to be
 * positioned correctly on scaled images in the web application.
 *
 * Calculations:
 * - percentX = (x / originalWidth) * 100
 * - percentY = (y / originalHeight) * 100
 * - percentWidth = (width / originalWidth) * 100
 * - percentHeight = (height / originalHeight) * 100
 */

import fs from "fs-extra";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

interface PageMetadata {
  width: number;
  height: number;
}

interface PagesManifest {
  [pageKey: string]: PageMetadata;
}

interface Bubble {
  id: string;
  box_2d: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
  style?: {
    left: string;
    top: string;
    width: string;
    height: string;
  };
}

type BubblesCache = Record<string, Bubble[]>;

/**
 * Parse command-line arguments
 */
function parseArgs(): { issue: string; overwrite?: boolean; dryRun?: boolean } {
  const args = process.argv.slice(2);

  // Check for help flag
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage: npm run add-bubble-styles [options]

Options:
  --issue=N, --issue N        Issue number (e.g., --issue=1 for issue-1, default: issue-1)
  --overwrite                  Overwrite existing style objects in bubbles
  --dry-run                    Show what would be changed without saving
  --help, -h                  Show this help message

Examples:
  npm run add-bubble-styles                    Add styles for issue-1
  npm run add-bubble-styles --issue=2         Add styles for issue-2
  npm run add-bubble-styles --overwrite       Overwrite existing styles
  npm run add-bubble-styles --dry-run         Preview changes without saving
`);
    process.exit(0);
  }

  let issue = "issue-1";
  let overwrite = false;
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
    if (arg === "--overwrite") {
      overwrite = true;
    }
    if (arg === "--dry-run") {
      dryRun = true;
    }
  }

  return { issue, overwrite, dryRun };
}

/**
 * Convert page key from bubbles.json format to pages.json format
 * e.g., "page-05.jpg" -> "page-05"
 */
function normalizePageKey(pageKey: string): string {
  return pageKey.replace(/\.jpg$/, "");
}

/**
 * Calculate percentage-based style for a bubble
 */
function calculateStyle(
  bubble: Bubble,
  pageWidth: number,
  pageHeight: number,
): { left: string; top: string; width: string; height: string } | null {
  const { x, y, width, height } = bubble.box_2d;

  // Check if all required values are present
  if (
    x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined
  ) {
    return null;
  }

  // Calculate percentages
  const percentX = (x / pageWidth) * 100;
  const percentY = (y / pageHeight) * 100;
  const percentWidth = (width / pageWidth) * 100;
  const percentHeight = (height / pageHeight) * 100;

  return {
    left: `${percentX.toFixed(2)}%`,
    top: `${percentY.toFixed(2)}%`,
    width: `${percentWidth.toFixed(2)}%`,
    height: `${percentHeight.toFixed(2)}%`,
  };
}

/**
 * Main execution
 */
async function main() {
  try {
    const { issue, overwrite, dryRun } = parseArgs();

    const ISSUE_DIR = join(
      PROJECT_ROOT,
      "assets",
      "comics",
      "tmnt-mmpr-iii",
      issue,
    );
    const BUBBLES_FILE = join(ISSUE_DIR, "bubbles.json");
    const PAGES_FILE = join(ISSUE_DIR, "pages.json");

    // Check if files exist
    if (!(await fs.pathExists(BUBBLES_FILE))) {
      console.error(`❌ Bubbles file not found: ${BUBBLES_FILE}`);
      process.exit(1);
    }

    if (!(await fs.pathExists(PAGES_FILE))) {
      console.error(`❌ Pages metadata file not found: ${PAGES_FILE}`);
      console.error(
        `   Please run: npm run generate-pages-metadata --issue=${issue}`,
      );
      process.exit(1);
    }

    if (dryRun) {
      console.log(`🔍 Dry run mode - no changes will be saved\n`);
    }

    console.log(`📄 Adding style objects to bubbles for ${issue}...\n`);

    // Load bubbles.json
    const bubblesData = await fs.readFile(BUBBLES_FILE, "utf-8");
    const bubblesCache = JSON.parse(bubblesData) as BubblesCache;

    // Load pages.json
    const pagesData = await fs.readFile(PAGES_FILE, "utf-8");
    const pagesManifest = JSON.parse(pagesData) as PagesManifest;

    let totalBubbles = 0;
    let updatedBubbles = 0;
    let skippedBubbles = 0;
    let missingDimensions = 0;

    // Process each page
    for (const [pageKey, bubbles] of Object.entries(bubblesCache)) {
      const normalizedPageKey = normalizePageKey(pageKey);
      const pageMetadata = pagesManifest[normalizedPageKey];

      if (!pageMetadata) {
        console.warn(
          `   ⚠️  Page metadata not found for ${pageKey} (looking for ${normalizedPageKey})`,
        );
        missingDimensions++;
        continue;
      }

      const { width: pageWidth, height: pageHeight } = pageMetadata;

      // Process each bubble on this page
      for (const bubble of bubbles) {
        totalBubbles++;

        // Skip if style already exists and overwrite is false
        if (bubble.style && !overwrite) {
          skippedBubbles++;
          continue;
        }

        // Calculate style
        const style = calculateStyle(bubble, pageWidth, pageHeight);

        if (!style) {
          console.warn(
            `   ⚠️  Bubble ${bubble.id}: Missing required box_2d values (x, y, width, height)`,
          );
          skippedBubbles++;
          continue;
        }

        // Add style to bubble
        bubble.style = style;
        updatedBubbles++;
      }
    }

    // Save updated bubbles.json
    if (!dryRun) {
      await fs.writeJSON(BUBBLES_FILE, bubblesCache, { spaces: 2 });
      console.log(`\n✅ Complete!`);
    } else {
      console.log(`\n🔍 Dry run complete (no changes saved)`);
    }

    console.log(`   Total bubbles: ${totalBubbles}`);
    console.log(`   Updated: ${updatedBubbles}`);
    if (skippedBubbles > 0) {
      console.log(`   Skipped: ${skippedBubbles}`);
    }
    if (missingDimensions > 0) {
      console.log(`   Pages with missing dimensions: ${missingDimensions}`);
    }
    console.log(`   Output: ${BUBBLES_FILE}\n`);
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

main();


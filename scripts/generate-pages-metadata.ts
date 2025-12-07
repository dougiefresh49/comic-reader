#!/usr/bin/env node

/**
 * Generate pages.json metadata file with image dimensions
 *
 * Reads original page images from the assets directory and extracts
 * width and height metadata, outputting a pages.json file for each issue.
 * This metadata is essential for properly positioning bubble overlays
 * on scaled images in the web application.
 */

import fs from "fs-extra";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";
import { glob } from "glob";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

/**
 * Parse command-line arguments
 */
function parseArgs(): { issue: string; overwrite?: boolean } {
  const args = process.argv.slice(2);

  // Check for help flag
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage: npm run generate-pages-metadata [options]

Options:
  --issue=N, --issue N        Issue number (e.g., --issue=1 for issue-1, default: issue-1)
  --overwrite                  Overwrite existing pages.json file
  --help, -h                  Show this help message

Examples:
  npm run generate-pages-metadata                    Generate metadata for issue-1
  npm run generate-pages-metadata --issue=2         Generate metadata for issue-2
  npm run generate-pages-metadata --overwrite       Overwrite existing file
`);
    process.exit(0);
  }

  let issue = "issue-1";
  let overwrite = false;

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
  }

  return { issue, overwrite };
}

interface PageMetadata {
  width: number;
  height: number;
}

interface PagesManifest {
  [pageKey: string]: PageMetadata;
}

/**
 * Main execution
 */
async function main() {
  try {
    const { issue, overwrite } = parseArgs();

    const ASSETS_DIR = join(
      PROJECT_ROOT,
      "assets",
      "comics",
      "tmnt-mmpr-iii",
      issue,
    );
    const PAGES_DIR = join(ASSETS_DIR, "pages");
    const OUTPUT_FILE = join(ASSETS_DIR, "pages.json");

    // Check if assets directory exists
    if (!(await fs.pathExists(ASSETS_DIR))) {
      console.error(`❌ Assets directory not found: ${ASSETS_DIR}`);
      process.exit(1);
    }

    // Check if pages directory exists
    if (!(await fs.pathExists(PAGES_DIR))) {
      console.error(`❌ Pages directory not found: ${PAGES_DIR}`);
      process.exit(1);
    }

    // Check if output file exists
    if ((await fs.pathExists(OUTPUT_FILE)) && !overwrite) {
      console.error(
        `❌ Output file already exists: ${OUTPUT_FILE}\n   Use --overwrite to replace it`,
      );
      process.exit(1);
    }

    console.log(`📄 Generating pages.json metadata for ${issue}...\n`);

    // Find all page images
    const pageFiles = await glob("page-*.jpg", {
      cwd: PAGES_DIR,
      absolute: true,
    });
    pageFiles.sort();

    if (pageFiles.length === 0) {
      console.error(`❌ No page images found in ${PAGES_DIR}`);
      process.exit(1);
    }

    console.log(`Found ${pageFiles.length} page images\n`);

    const pagesManifest: PagesManifest = {};
    let processed = 0;
    let errors = 0;

    // Process each page
    for (const pagePath of pageFiles) {
      const filename = pagePath.split("/").pop() ?? "";
      const pageKey = filename.replace(".jpg", "");

      try {
        // Get image metadata using sharp
        const metadata = await sharp(pagePath).metadata();

        if (!metadata.width || !metadata.height) {
          console.error(`   ⚠️  ${filename}: Could not extract dimensions`);
          errors++;
          continue;
        }

        pagesManifest[pageKey] = {
          width: metadata.width,
          height: metadata.height,
        };

        console.log(
          `   ✅ ${filename}: ${metadata.width}x${metadata.height}`,
        );
        processed++;
      } catch (error) {
        console.error(`   ❌ ${filename}: ${error}`);
        errors++;
      }
    }

    // Write output file
    await fs.writeJSON(OUTPUT_FILE, pagesManifest, { spaces: 2 });

    console.log(`\n✅ Complete!`);
    console.log(`   Processed: ${processed} pages`);
    if (errors > 0) {
      console.log(`   Errors: ${errors} pages`);
    }
    console.log(`   Output: ${OUTPUT_FILE}\n`);
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

main();


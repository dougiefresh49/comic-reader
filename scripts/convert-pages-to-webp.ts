#!/usr/bin/env node

/**
 * Convert comic page images from JPEG to WebP format
 *
 * Converts all page images in the pages directory to WebP format
 * for optimal web delivery with better compression and quality.
 */

import fs from "fs-extra";
import { join, dirname, extname, basename } from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

/**
 * Parse command-line arguments
 */
function parseArgs(): { issue: string; quality?: number; overwrite?: boolean } {
  const args = process.argv.slice(2);

  // Check for help flag
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage: npm run convert-pages-to-webp [options]

Options:
  --issue=N, --issue N        Issue number (e.g., --issue=1 for issue-1, default: issue-1)
  --quality=N                 WebP quality (0-100, default: 85)
  --overwrite                 Overwrite existing WebP files
  --help, -h                  Show this help message

Examples:
  npm run convert-pages-to-webp                    Convert pages for issue-1
  npm run convert-pages-to-webp --issue=2         Convert pages for issue-2
  npm run convert-pages-to-webp --quality=90      Use higher quality (90)
  npm run convert-pages-to-webp --overwrite       Overwrite existing files
`);
    process.exit(0);
  }

  let issue = "issue-1";
  let quality = 85;
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
    if (arg.startsWith("--quality=")) {
      const qualityNum = parseInt(arg.split("=")[1]?.trim() ?? "85", 10);
      if (!isNaN(qualityNum) && qualityNum >= 0 && qualityNum <= 100) {
        quality = qualityNum;
      }
    }
    if (arg === "--quality") {
      const nextArg = args[i + 1];
      if (nextArg) {
        const qualityNum = parseInt(nextArg.trim(), 10);
        if (!isNaN(qualityNum) && qualityNum >= 0 && qualityNum <= 100) {
          quality = qualityNum;
        }
      }
    }
    if (arg === "--overwrite") {
      overwrite = true;
    }
  }

  return { issue, quality, overwrite };
}

/**
 * Main execution
 */
async function main() {
  try {
    console.log("🖼️  Starting JPEG to WebP conversion...\n");

    // Parse arguments
    const { issue, quality, overwrite } = parseArgs();

    // Set up paths
    const COMIC_DIR = join(PROJECT_ROOT, "assets", "comics", "tmnt-mmpr-iii");
    const ISSUE_DIR = join(COMIC_DIR, issue);
    const PAGES_DIR = join(ISSUE_DIR, "pages");
    const OUTPUT_DIR = join(ISSUE_DIR, "pages-webp");

    console.log(`📁 Issue: ${issue}`);
    console.log(`📖 Input: ${PAGES_DIR}`);
    console.log(`💾 Output: ${OUTPUT_DIR}`);
    console.log(`🎨 Quality: ${quality}`);
    console.log(`🔄 Overwrite: ${overwrite ? "Yes" : "No"}\n`);

    // Check if input directory exists
    if (!(await fs.pathExists(PAGES_DIR))) {
      console.error(`❌ Pages directory not found: ${PAGES_DIR}`);
      process.exit(1);
    }

    // Ensure output directory exists
    await fs.ensureDir(OUTPUT_DIR);

    // Get all JPEG files
    console.log("📋 Scanning for JPEG files...");
    const files = await fs.readdir(PAGES_DIR);
    const jpegFiles = files
      .filter(
        (file) =>
          file.toLowerCase().endsWith(".jpg") ||
          file.toLowerCase().endsWith(".jpeg"),
      )
      .sort();

    if (jpegFiles.length === 0) {
      console.log("⚠️  No JPEG files found in pages directory");
      return;
    }

    console.log(`   ✓ Found ${jpegFiles.length} JPEG file(s)\n`);

    // Convert each file
    console.log("🔄 Converting to WebP...\n");
    let converted = 0;
    let skipped = 0;
    let errors = 0;
    let totalOriginalSize = 0;
    let totalWebPSize = 0;

    for (let i = 0; i < jpegFiles.length; i++) {
      const jpegFile = jpegFiles[i]!;
      const jpegPath = join(PAGES_DIR, jpegFile);
      const webpFile = basename(jpegFile, extname(jpegFile)) + ".webp";
      const webpPath = join(OUTPUT_DIR, webpFile);

      // Check if WebP already exists
      if (!overwrite && (await fs.pathExists(webpPath))) {
        console.log(
          `   [${i + 1}/${jpegFiles.length}] ⏭️  Skipped ${jpegFile} (already exists)`,
        );
        skipped++;
        continue;
      }

      try {
        console.log(
          `   [${i + 1}/${jpegFiles.length}] Converting ${jpegFile}...`,
        );

        // Get original file size
        const originalStats = await fs.stat(jpegPath);
        const originalSize = originalStats.size;

        // Convert to WebP
        await sharp(jpegPath)
          .webp({ quality, effort: 6 }) // effort: 6 is a good balance of speed vs compression
          .toFile(webpPath);

        // Get WebP file size
        const webpStats = await fs.stat(webpPath);
        const webpSize = webpStats.size;
        const savings = originalSize - webpSize;
        const savingsPercent = ((savings / originalSize) * 100).toFixed(1);

        totalOriginalSize += originalSize;
        totalWebPSize += webpSize;

        console.log(
          `      ✓ ${webpFile} (${(originalSize / 1024 / 1024).toFixed(2)}MB → ${(webpSize / 1024 / 1024).toFixed(2)}MB, ${savingsPercent}% smaller)`,
        );

        converted++;
      } catch (error) {
        console.error(
          `      ❌ Error: ${error instanceof Error ? error.message : String(error)}`,
        );
        errors++;
      }
    }

    // Summary
    console.log("\n📊 Summary:");
    console.log(`   Converted: ${converted}`);
    console.log(`   Skipped: ${skipped}`);
    console.log(`   Errors: ${errors}`);
    console.log(`   Total files: ${jpegFiles.length}`);
    if (converted > 0) {
      const totalSavings = totalOriginalSize - totalWebPSize;
      const totalSavingsPercent = (
        (totalSavings / totalOriginalSize) *
        100
      ).toFixed(1);
      console.log(
        `\n💾 Size reduction: ${(totalOriginalSize / 1024 / 1024).toFixed(2)}MB → ${(totalWebPSize / 1024 / 1024).toFixed(2)}MB`,
      );
      console.log(`   Savings: ${(totalSavings / 1024 / 1024).toFixed(2)}MB (${totalSavingsPercent}%)`);
    }
    console.log("\n✅ Conversion complete!");
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

main();


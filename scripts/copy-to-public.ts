#!/usr/bin/env node

/**
 * Copy necessary content files from assets to public directory
 *
 * Copies:
 * - WebP page images (from pages-webp/)
 * - Audio files (from audio/)
 * - JSON data files (context-cache.json, audio-timestamps.json)
 * - Castlist (from root comic directory)
 *
 * Files are organized in public/comics/tmnt-mmpr-iii/issue-X/ for Next.js serving
 */

import fs from "fs-extra";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";

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
Usage: npm run copy-to-public [options]

Options:
  --issue=N, --issue N        Issue number (e.g., --issue=1 for issue-1, default: issue-1)
  --overwrite                  Overwrite existing files in public directory
  --help, -h                  Show this help message

Examples:
  npm run copy-to-public                    Copy files for issue-1
  npm run copy-to-public --issue=2         Copy files for issue-2
  npm run copy-to-public --overwrite       Overwrite existing files
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

/**
 * Copy files from source to destination
 */
async function copyFiles(
  sourceDir: string,
  destDir: string,
  filePattern: string,
  description: string,
  overwrite: boolean,
): Promise<{ copied: number; skipped: number; errors: number }> {
  let copied = 0;
  let skipped = 0;
  let errors = 0;

  if (!(await fs.pathExists(sourceDir))) {
    console.log(`   ⚠️  ${description} directory not found: ${sourceDir}`);
    return { copied, skipped, errors };
  }

  await fs.ensureDir(destDir);

  const files = await fs.readdir(sourceDir);
  const matchingFiles = files.filter((file) => {
    if (filePattern.includes("*")) {
      const pattern = filePattern.replace("*", ".*");
      return new RegExp(pattern).test(file);
    }
    return file.endsWith(filePattern);
  });

  for (const file of matchingFiles) {
    const sourcePath = join(sourceDir, file);
    const destPath = join(destDir, file);

    try {
      // Check if file already exists
      if (!overwrite && (await fs.pathExists(destPath))) {
        skipped++;
        continue;
      }

      await fs.copy(sourcePath, destPath);
      copied++;
    } catch (error) {
      console.error(
        `      ❌ Error copying ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
      errors++;
    }
  }

  return { copied, skipped, errors };
}

/**
 * Main execution
 */
async function main() {
  try {
    console.log("📦 Starting copy to public directory...\n");

    // Parse arguments
    const { issue, overwrite } = parseArgs();

    // Set up paths
    const COMIC_DIR = join(PROJECT_ROOT, "assets", "comics", "tmnt-mmpr-iii");
    const ISSUE_DIR = join(COMIC_DIR, issue);
    const PUBLIC_COMIC_DIR = join(
      PROJECT_ROOT,
      "public",
      "comics",
      "tmnt-mmpr-iii",
      issue,
    );

    console.log(`📁 Issue: ${issue}`);
    console.log(`📖 Source: ${ISSUE_DIR}`);
    console.log(`💾 Destination: ${PUBLIC_COMIC_DIR}`);
    console.log(`🔄 Overwrite: ${overwrite ? "Yes" : "No"}\n`);

    // Check if issue directory exists
    if (!(await fs.pathExists(ISSUE_DIR))) {
      console.error(`❌ Issue directory not found: ${ISSUE_DIR}`);
      process.exit(1);
    }

    // Ensure public directory exists
    await fs.ensureDir(PUBLIC_COMIC_DIR);

    let totalCopied = 0;
    let totalSkipped = 0;
    let totalErrors = 0;

    // 1. Copy WebP page images
    console.log("🖼️  Copying WebP page images...");
    const pagesWebpSource = join(ISSUE_DIR, "pages-webp");
    const pagesWebpDest = join(PUBLIC_COMIC_DIR, "pages");
    const pagesResult = await copyFiles(
      pagesWebpSource,
      pagesWebpDest,
      ".webp",
      "WebP pages",
      overwrite,
    );
    totalCopied += pagesResult.copied;
    totalSkipped += pagesResult.skipped;
    totalErrors += pagesResult.errors;
    console.log(
      `   ✓ Copied: ${pagesResult.copied}, Skipped: ${pagesResult.skipped}, Errors: ${pagesResult.errors}\n`,
    );

    // 2. Copy audio files
    console.log("🎵 Copying audio files...");
    const audioSource = join(ISSUE_DIR, "audio");
    const audioDest = join(PUBLIC_COMIC_DIR, "audio");
    const audioResult = await copyFiles(
      audioSource,
      audioDest,
      ".mp3",
      "Audio",
      overwrite,
    );
    totalCopied += audioResult.copied;
    totalSkipped += audioResult.skipped;
    totalErrors += audioResult.errors;
    console.log(
      `   ✓ Copied: ${audioResult.copied}, Skipped: ${audioResult.skipped}, Errors: ${audioResult.errors}\n`,
    );

    // 3. Copy context-cache.json
    console.log("📄 Copying context-cache.json...");
    const contextCacheSource = join(ISSUE_DIR, "context-cache.json");
    const contextCacheDest = join(PUBLIC_COMIC_DIR, "context-cache.json");
    if (await fs.pathExists(contextCacheSource)) {
      if (!overwrite && (await fs.pathExists(contextCacheDest))) {
        console.log("   ⏭️  Skipped (already exists)\n");
        totalSkipped++;
      } else {
        await fs.copy(contextCacheSource, contextCacheDest);
        console.log("   ✓ Copied\n");
        totalCopied++;
      }
    } else {
      console.log("   ⚠️  File not found\n");
    }

    // 4. Copy audio-timestamps.json
    console.log("⏱️  Copying audio-timestamps.json...");
    const timestampsSource = join(ISSUE_DIR, "audio-timestamps.json");
    const timestampsDest = join(PUBLIC_COMIC_DIR, "audio-timestamps.json");
    if (await fs.pathExists(timestampsSource)) {
      if (!overwrite && (await fs.pathExists(timestampsDest))) {
        console.log("   ⏭️  Skipped (already exists)\n");
        totalSkipped++;
      } else {
        await fs.copy(timestampsSource, timestampsDest);
        console.log("   ✓ Copied\n");
        totalCopied++;
      }
    } else {
      console.log("   ⚠️  File not found\n");
    }

    // 5. Copy castlist.json (from root comic directory)
    console.log("🎭 Copying castlist.json...");
    const castlistSource = join(COMIC_DIR, "castlist.json");
    const castlistDest = join(PUBLIC_COMIC_DIR, "castlist.json");
    if (await fs.pathExists(castlistSource)) {
      if (!overwrite && (await fs.pathExists(castlistDest))) {
        console.log("   ⏭️  Skipped (already exists)\n");
        totalSkipped++;
      } else {
        await fs.copy(castlistSource, castlistDest);
        console.log("   ✓ Copied\n");
        totalCopied++;
      }
    } else {
      console.log("   ⚠️  File not found\n");
    }

    // Summary
    console.log("📊 Summary:");
    console.log(`   Files copied: ${totalCopied}`);
    console.log(`   Files skipped: ${totalSkipped}`);
    console.log(`   Errors: ${totalErrors}`);
    console.log(`\n✅ Copy complete!`);
    console.log(
      `\n📂 Files are now available at: /comics/tmnt-mmpr-iii/${issue}/`,
    );
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

main();


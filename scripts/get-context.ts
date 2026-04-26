#!/usr/bin/env node

/**
 * Script 1: get-context
 *
 * Discovery pass that identifies speech bubbles, determines speakers, and emotions.
 * Uses Roboflow for detection, Gemini Vision API for OCR, and Gemini for context analysis.
 */

import fs from "fs-extra";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import https from "https";
import http from "http";
import { glob } from "glob";
import { GoogleGenAI } from "@google/genai";
import pLimit from "p-limit";
import { env } from "~/env.mjs";
import { runOCR } from "./utils/ocr.js";
import { detectTextRegions } from "./utils/roboflow.js";
import { analyzeContext, type Bubble } from "./utils/gemini-context.js";
import {
  loadBookConfig,
  loadRoster,
  saveRoster,
  formatRosterForPrompt,
  addCharacterToRoster,
} from "./utils/roster.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

// Tolerance for spatial deduplication (5% as per spec)
const SPATIAL_TOLERANCE = 0.05;

type ContextCache = Record<string, Bubble[]>;

/* ------- EXECUTION ------- */
main();
/* ---------------------------- */

function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https") ? https : http;
    const request = protocol.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        fetchText(response.headers.location!).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode} for ${url}`));
        return;
      }
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve(Buffer.concat(chunks).toString("utf-8")),
      );
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end();
  });
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Main execution
 */
async function main() {
  try {
    console.log("🚀 Starting get-context script...\n");

    // Parse command-line arguments
    const {
      book,
      issue,
      page: pageNum,
      startAt,
      useSpatialDedup,
      skipGemini,
    } = parseArgs();

    const ISSUE_DIR = join(PROJECT_ROOT, "assets", "comics", book, issue);
    const BOOK_DIR = join(PROJECT_ROOT, "assets", "comics", book);
    const ASSETS_DIR = join(ISSUE_DIR, "pages");
    const CACHE_FILE = join(ISSUE_DIR, "bubbles.json");
    const PREDICTIONS_DIR = join(ISSUE_DIR, "data", "predictions");
    const OCR_CROPS_DIR = join(ISSUE_DIR, "data", "ocr-crops");
    const GEMINI_CONTEXT_DIR = join(ISSUE_DIR, "data", "gemini-context");
    const WIKI_CACHE_FILE = join(ISSUE_DIR, "data", "wiki-cache.txt");
    const LIMIT = pLimit(2);

    // Initialize Gemini
    const gemini = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

    if (!gemini) {
      console.error("❌ Gemini client required but not provided");
      process.exit(1);
    }

    // Load book config + roster
    const bookConfig = await loadBookConfig(BOOK_DIR);
    let roster = await loadRoster(BOOK_DIR);
    if (bookConfig) console.log(`📚 Book: ${bookConfig.title}`);
    if (Object.keys(roster).length > 0) {
      console.log(
        `🎭 Roster: ${Object.keys(roster).length} character(s) loaded\n`,
      );
    }

    // Fetch + cache wiki content if configured
    const characterContextInstruction =
      bookConfig?.characterContext ??
      "Use your knowledge of comics and pop culture to identify characters by their proper canonical names where possible.";
    let wikiContent: string | null = null;
    const wikiUrl = bookConfig?.wikiUrls?.[issue];
    if (wikiUrl) {
      if (await fs.pathExists(WIKI_CACHE_FILE)) {
        wikiContent = await fs.readFile(WIKI_CACHE_FILE, "utf-8");
        console.log(
          `📖 Wiki content loaded from cache (${wikiContent.length} chars)\n`,
        );
      } else {
        try {
          console.log(`🌐 Fetching wiki content from ${wikiUrl}...`);
          const html = await fetchText(wikiUrl);
          wikiContent = stripHtml(html);
          await fs.ensureDir(dirname(WIKI_CACHE_FILE));
          await fs.writeFile(WIKI_CACHE_FILE, wikiContent, "utf-8");
          console.log(
            `   ✓ Cached wiki content (${wikiContent.length} chars)\n`,
          );
        } catch (err) {
          console.warn(
            `⚠️  Wiki fetch failed: ${err instanceof Error ? err.message : String(err)} — continuing without it\n`,
          );
        }
      }
    }

    // Build additional context injected into every page prompt
    const contextParts: string[] = [characterContextInstruction];
    const rosterFormatted = formatRosterForPrompt(roster);
    if (rosterFormatted) contextParts.push(rosterFormatted);
    if (wikiContent) {
      contextParts.push(
        `Reference — issue wiki page (use for character identification):\n${wikiContent}`,
      );
    }
    const additionalContext = contextParts.join("\n\n");

    // Ensure data directories exist
    await fs.ensureDir(dirname(CACHE_FILE));
    await fs.ensureDir(PREDICTIONS_DIR);
    await fs.ensureDir(OCR_CROPS_DIR);
    await fs.ensureDir(GEMINI_CONTEXT_DIR);
    // Load existing cache
    let cache: ContextCache = {};
    try {
      const existing = await fs.readFile(CACHE_FILE, "utf-8");
      cache = JSON.parse(existing) as ContextCache;
      console.log(
        `Loaded existing cache with ${Object.keys(cache).length} pages\n`,
      );
    } catch {
      console.log("No existing cache found, starting fresh\n");
    }

    const pageFiles = await getPageFiles(ASSETS_DIR, pageNum, startAt);

    // Process pages with concurrency limit
    const results = await Promise.all(
      pageFiles.map((pagePath) =>
        LIMIT(async () => {
          const pageName = pagePath.split("/").pop() ?? "unknown";

          // Skip if already processed
          if (cache[pageName]) {
            console.log(`⏭️  Skipping ${pageName} (already in cache)`);
            return { pageName, bubbles: cache[pageName] };
          }

          const bubbles = await processPage(
            pagePath,
            gemini,
            {
              predictionsDir: PREDICTIONS_DIR,
              ocrCropsDir: OCR_CROPS_DIR,
              geminiContextDir: GEMINI_CONTEXT_DIR,
            },
            { useSpatialDedup, skipGemini, additionalContext },
          );
          return { pageName, bubbles };
        }),
      ),
    );

    // Update cache
    for (const { pageName, bubbles } of results) {
      cache[pageName] = bubbles;
    }

    // Update roster with any new characters found this run
    let rosterUpdated = false;
    for (const { pageName, bubbles } of results) {
      const pageNumStr = pageName.replace("page-", "");
      const pageNumber = parseInt(pageNumStr, 10);
      const safePageNumber = isNaN(pageNumber) ? 0 : pageNumber;
      for (const bubble of bubbles) {
        if (bubble.speaker && bubble.type === "SPEECH") {
          const before = Object.keys(roster).length;
          roster = addCharacterToRoster(
            roster,
            bubble.speaker,
            issue,
            safePageNumber,
          );
          if (Object.keys(roster).length > before) rosterUpdated = true;
        }
      }
    }
    if (rosterUpdated) {
      await saveRoster(BOOK_DIR, roster);
      console.log(
        `\n📝 Roster updated: ${Object.keys(roster).length} character(s) total`,
      );
    }

    // Save cache
    await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
    console.log(`\n✓ Saved cache to ${CACHE_FILE}`);

    console.log(`\n📊 Summary:`);
    if (pageNum !== null) {
      console.log(
        `  Processed single page: page-${String(pageNum).padStart(2, "0")}.jpg`,
      );
    } else if (startAt !== null) {
      console.log(
        `  Processed pages starting from: page-${String(startAt).padStart(2, "0")}.jpg`,
      );
      console.log(`  Total pages processed: ${Object.keys(cache).length}`);
    } else {
      console.log(`  Total pages processed: ${Object.keys(cache).length}`);
    }
    console.log(
      `  Total bubbles: ${Object.values(cache).reduce((sum, bubbles) => sum + bubbles.length, 0)}`,
    );
    logUniqueCharacters(cache);

    console.log("\n✅ Done!");
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

/**
 * Parse command-line arguments
 */
function parseArgs(): {
  book: string;
  issue: string;
  page: number | null;
  startAt: number | null;
  useSpatialDedup: boolean;
  skipGemini: boolean;
} {
  const args = process.argv.slice(2);

  // Check for help flag
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage: npm run get-context [options]

Options:
  --page=N, --page N, -p N     Process only the specified page number (e.g., --page=3 for page-03.jpg)
  --start-at=N                 Process pages starting from the specified page number (e.g., --start-at=5 processes pages 5, 6, 7, etc.)
  --use-spatial-dedup           Enable spatial deduplication (disabled by default)
  --skip-gemini                 Stop before Gemini analysis (for validation)
  --help, -h                    Show this help message

Examples:
  npm run get-context                           Process all pages
  npm run get-context --page=3                  Process only page-03.jpg
  npm run get-context --start-at=5              Process pages starting from page-05.jpg onwards
  npm run get-context --page=3 --skip-gemini    Process page-03 but stop before Gemini
  npm run get-context --use-spatial-dedup       Enable spatial deduplication
`);
    process.exit(0);
  }

  let book = process.env.COMIC_BOOK ?? "tmnt-mmpr-iii";
  let issue = process.env.COMIC_ISSUE ?? "issue-1";
  let page: number | null = null;
  let startAt: number | null = null;
  let useSpatialDedup = false;
  let skipGemini = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    if (arg.startsWith("--book=")) {
      book = arg.split("=")[1]?.trim() ?? book;
    }
    if (arg === "--book") {
      const nextArg = args[i + 1];
      if (nextArg) book = nextArg.trim();
    }
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
    if (arg.startsWith("--page=")) {
      const pageNum = parseInt(arg.split("=")[1] ?? "", 10);
      if (!isNaN(pageNum) && pageNum > 0) {
        page = pageNum;
      }
    }
    if (arg === "--page" || arg === "-p") {
      const nextArg = args[i + 1];
      if (nextArg) {
        const pageNum = parseInt(nextArg, 10);
        if (!isNaN(pageNum) && pageNum > 0) {
          page = pageNum;
        }
      }
    }
    if (arg.startsWith("--start-at=")) {
      const startPage = parseInt(arg.split("=")[1] ?? "", 10);
      if (!isNaN(startPage) && startPage > 0) {
        startAt = startPage;
      }
    }
    if (arg === "--start-at") {
      const nextArg = args[i + 1];
      if (nextArg) {
        const startPage = parseInt(nextArg, 10);
        if (!isNaN(startPage) && startPage > 0) {
          startAt = startPage;
        }
      }
    }
    if (arg === "--use-spatial-dedup") {
      useSpatialDedup = true;
    }
    if (arg === "--skip-gemini") {
      skipGemini = true;
    }
  }

  return { book, issue, page, startAt, useSpatialDedup, skipGemini };
}

/**
 * Process a single page
 */
async function processPage(
  pagePath: string,
  gemini: GoogleGenAI,
  dirs: {
    predictionsDir: string;
    ocrCropsDir: string;
    geminiContextDir: string;
  },
  options: {
    useSpatialDedup: boolean;
    skipGemini: boolean;
    additionalContext?: string;
  },
): Promise<Bubble[]> {
  const pageName = pagePath.split("/").pop()?.replace(".jpg", "") ?? "unknown";
  console.log(`\n📄 Processing ${pageName}...`);
  console.log(`   Path: ${pagePath}`);

  // Read image
  const imageBuffer = await fs.readFile(pagePath);
  console.log(`   Image size: ${imageBuffer.length} bytes`);

  // Step 1: Detect text regions with Roboflow
  const predictions = await detectTextRegions(imageBuffer, {
    outDir: dirs.predictionsDir,
    pageName,
    useSpatialDedup: options.useSpatialDedup,
    spatialDedupTolerance: SPATIAL_TOLERANCE,
  });

  if (predictions.length === 0) {
    console.log(`   ❌ No predictions found`);
    return [];
  }

  // Step 2: OCR pass
  const ocrPredictions = await runOCR(predictions, gemini, imageBuffer, {
    pageName,
    outDir: dirs.ocrCropsDir,
  });

  // Step 3: Analyze context with Gemini
  const { bubbles, skipped } = await analyzeContext(
    gemini,
    imageBuffer,
    ocrPredictions,
    pageName,
    {
      skipGemini: options.skipGemini,
      outDir: dirs.geminiContextDir,
      additionalContext: options.additionalContext,
    },
  );

  console.log(`\n✅ Processing complete:`);
  console.log(`   Final bubbles: ${bubbles.length}`);
  console.log(`   Skipped: ${skipped.length}`);
  if (skipped.length > 0) {
    console.log(`   Skipped items:`, skipped);
  }

  return bubbles;
}

/**
 * Helpers
 */

async function getPageFiles(
  assetsDir: string,
  pageNum: number | null,
  startAt: number | null,
): Promise<string[]> {
  // Get list of page images
  let pageFiles = await glob("page-*.jpg", {
    cwd: assetsDir,
    absolute: true,
  });
  pageFiles.sort();

  // If --page is specified, it takes precedence (process only that page)
  if (pageNum !== null) {
    const targetPage = `page-${String(pageNum).padStart(2, "0")}.jpg`;
    pageFiles = pageFiles.filter((path) => {
      const filename = path.split("/").pop() ?? "";
      return filename === targetPage;
    });

    if (pageFiles.length === 0) {
      console.error(
        `❌ Page ${pageNum} (${targetPage}) not found in ${assetsDir}`,
      );
      process.exit(1);
    }
    console.log(`📄 Processing single page: ${targetPage}\n`);
  } else if (startAt !== null) {
    // Filter pages starting from the specified page number
    const startPageStr = `page-${String(startAt).padStart(2, "0")}`;
    pageFiles = pageFiles.filter((path) => {
      const filename = path.split("/").pop() ?? "";
      // Extract page number from filename (e.g., "page-05.jpg" -> 5)
      const pageMatch = filename.match(/^page-(\d+)\.jpg$/);
      if (pageMatch) {
        const pageNumber = parseInt(pageMatch[1] ?? "", 10);
        return !isNaN(pageNumber) && pageNumber >= startAt;
      }
      return false;
    });

    if (pageFiles.length === 0) {
      console.error(
        `❌ No pages found starting from page ${startAt} in ${assetsDir}`,
      );
      process.exit(1);
    }
    console.log(
      `📄 Processing pages starting from: ${startPageStr}.jpg (${pageFiles.length} pages)\n`,
    );
  } else {
    if (pageFiles.length === 0) {
      console.error(`❌ No page images found in ${assetsDir}`);
      process.exit(1);
    }
    console.log(`Found ${pageFiles.length} pages to process\n`);
  }
  return pageFiles;
}

function logUniqueCharacters(cache: ContextCache): void {
  const characters = new Set<string>();
  for (const bubbles of Object.values(cache)) {
    for (const bubble of bubbles) {
      if (bubble.speaker && bubble.type === "SPEECH") {
        characters.add(bubble.speaker);
      }
    }
  }

  console.log(`\n🎭 Characters found:`);
  const sortedCharacters = Array.from(characters)
    .sort()
    .map((char) => `  - ${char}`)
    .join("\n");
  console.log(sortedCharacters);
}

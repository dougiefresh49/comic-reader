#!/usr/bin/env node

/**
 * Backfill script to add missing aiReasoning fields to bubbles in bubbles.json
 *
 * Finds all bubbles without aiReasoning and re-processes them through Gemini
 */

import fs from "fs-extra";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";
import { env } from "~/env.mjs";
import { analyzeContextGemini, type Bubble } from "./utils/gemini-context.js";
import type { Box2D } from "./utils/box-math.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

type ContextCache = Record<string, Bubble[]>;

interface BubbleWithPage {
  pageName: string;
  bubble: Bubble;
  index: number;
}

/**
 * Extract all unique characters from the cache
 */
function getAllUniqueCharacters(cache: ContextCache): string[] {
  const characters = new Set<string>();
  for (const bubbles of Object.values(cache)) {
    for (const bubble of bubbles) {
      if (bubble.speaker && bubble.type === "SPEECH") {
        characters.add(bubble.speaker);
      }
    }
  }
  return Array.from(characters).sort();
}

/**
 * Find all bubbles missing aiReasoning
 */
function findBubblesNeedingBackfill(cache: ContextCache): BubbleWithPage[] {
  const needsBackfill: BubbleWithPage[] = [];

  for (const [pageName, bubbles] of Object.entries(cache)) {
    for (let i = 0; i < bubbles.length; i++) {
      const bubble = bubbles[i]!;
      if (!bubble.aiReasoning) {
        needsBackfill.push({
          pageName,
          bubble,
          index: i,
        });
      }
    }
  }

  return needsBackfill;
}

/**
 * Convert bubble box_2d to Box2D format
 */
function bubbleToBox2D(bubble: Bubble): Box2D {
  // The box_2d in cache may have extra properties, but should have x, y, width, height
  const box = bubble.box_2d as Box2D & Record<string, unknown>;
  return {
    x: box.x ?? 0,
    y: box.y ?? 0,
    width: box.width ?? 0,
    height: box.height ?? 0,
  };
}

/**
 * Parse command-line arguments
 */
function parseArgs(): {
  issue: string;
  apiKeyName: "GEMINI_API_KEY" | "GEMINI_API_KEY_2";
} {
  const args = process.argv.slice(2);

  // Check for help flag
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage: npm run backfill-context [options]

Options:
  --issue=N, --issue N        Issue number (e.g., --issue=1 for issue-1, default: issue-1)
  --api-key=KEY               API key to use: "GEMINI_API_KEY" or "GEMINI_API_KEY_2" (default: GEMINI_API_KEY)
  --help, -h                  Show this help message

Examples:
  npm run backfill-context                           Backfill issue-1 with GEMINI_API_KEY
  npm run backfill-context --issue=2                 Backfill issue-2 with GEMINI_API_KEY
  npm run backfill-context --issue=2 --api-key=GEMINI_API_KEY_2  Backfill issue-2 with GEMINI_API_KEY_2
`);
    process.exit(0);
  }

  let issue = "issue-1";
  let apiKeyName: "GEMINI_API_KEY" | "GEMINI_API_KEY_2" = "GEMINI_API_KEY";

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
    if (arg.startsWith("--api-key=")) {
      const keyName = arg.split("=")[1]?.trim();
      if (keyName === "GEMINI_API_KEY" || keyName === "GEMINI_API_KEY_2") {
        apiKeyName = keyName;
      } else {
        console.warn(
          `⚠️  Invalid API key name: ${keyName}. Using default: GEMINI_API_KEY`,
        );
      }
    }
    if (arg === "--api-key") {
      const nextArg = args[i + 1];
      if (nextArg) {
        const keyName = nextArg.trim();
        if (keyName === "GEMINI_API_KEY" || keyName === "GEMINI_API_KEY_2") {
          apiKeyName = keyName;
        } else {
          console.warn(
            `⚠️  Invalid API key name: ${keyName}. Using default: GEMINI_API_KEY`,
          );
        }
      }
    }
  }

  return { issue, apiKeyName };
}

/**
 * Main execution
 */
async function main() {
  try {
    console.log("🔄 Starting backfill script...\n");

    // Parse arguments
    const { issue, apiKeyName } = parseArgs();

    // Set up paths based on issue
    const ISSUE_DIR = join(
      PROJECT_ROOT,
      "assets",
      "comics",
      "tmnt-mmpr-iii",
      issue,
    );
    const ASSETS_DIR = join(ISSUE_DIR, "pages");
    const CACHE_FILE = join(ISSUE_DIR, "bubbles.json");

    console.log(`📁 Issue: ${issue}`);
    console.log(`🔑 API Key: ${apiKeyName}\n`);

    // Initialize Gemini with selected API key
    const apiKey = env[apiKeyName];
    if (!apiKey) {
      console.error(
        `❌ API key ${apiKeyName} not found in environment variables`,
      );
      process.exit(1);
    }
    const gemini = new GoogleGenAI({ apiKey });

    // Load cache
    console.log("📖 Loading context cache...");
    let cache: ContextCache = {};
    try {
      const existing = await fs.readFile(CACHE_FILE, "utf-8");
      cache = JSON.parse(existing) as ContextCache;
      console.log(
        `   ✓ Loaded cache with ${Object.keys(cache).length} pages\n`,
      );
    } catch (error) {
      console.error(`❌ Failed to load cache: ${error}`);
      console.error(`   Cache file: ${CACHE_FILE}`);
      process.exit(1);
    }

    // Find bubbles needing backfill
    const needsBackfill = findBubblesNeedingBackfill(cache);
    console.log(
      `🔍 Found ${needsBackfill.length} bubbles missing aiReasoning\n`,
    );

    if (needsBackfill.length === 0) {
      console.log(
        "✅ All bubbles already have aiReasoning. Nothing to backfill!",
      );
      return;
    }

    // Get all unique characters for context
    const uniqueCharacters = getAllUniqueCharacters(cache);
    console.log(
      `📋 Using ${uniqueCharacters.length} unique characters for context\n`,
    );

    // Group by page to minimize image loading
    const byPage = new Map<string, BubbleWithPage[]>();
    for (const item of needsBackfill) {
      if (!byPage.has(item.pageName)) {
        byPage.set(item.pageName, []);
      }
      byPage.get(item.pageName)!.push(item);
    }

    console.log(`📄 Processing ${byPage.size} pages with missing data\n`);

    let processed = 0;
    let errors = 0;

    // Process each page
    for (const [pageName, bubbles] of byPage.entries()) {
      const pagePath = join(ASSETS_DIR, pageName);

      // Check if page file exists
      if (!(await fs.pathExists(pagePath))) {
        console.warn(`⚠️  Page file not found: ${pagePath}`);
        console.warn(`   Skipping ${bubbles.length} bubbles from this page\n`);
        errors += bubbles.length;
        continue;
      }

      console.log(`📄 Processing ${pageName} (${bubbles.length} bubbles)...`);

      // Load page image
      const imageBuffer = await fs.readFile(pagePath);

      // Process each bubble on this page
      for (let i = 0; i < bubbles.length; i++) {
        const { bubble, index } = bubbles[i]!;
        const textPreview =
          bubble.ocr_text.slice(0, 40) +
          (bubble.ocr_text.length > 40 ? "..." : "");

        console.log(
          `   [${i + 1}/${bubbles.length}] Backfilling: "${textPreview}"`,
        );

        try {
          const box = bubbleToBox2D(bubble);
          const context = await analyzeContextGemini(
            gemini,
            imageBuffer,
            bubble.ocr_text,
            box,
            uniqueCharacters,
          );

          // Update the bubble in cache
          const cacheBubble = cache[pageName]![index]!;
          cacheBubble.aiReasoning = context.aiReasoning;

          // Optionally update other fields if they're missing
          if (!cacheBubble.characterType && context.characterType) {
            cacheBubble.characterType = context.characterType;
          }
          if (!cacheBubble.side && context.side) {
            cacheBubble.side = context.side;
          }
          if (!cacheBubble.voiceDescription && context.voiceDescription) {
            cacheBubble.voiceDescription = context.voiceDescription;
          }
          if (!cacheBubble.textWithCues && context.textWithCues) {
            cacheBubble.textWithCues = context.textWithCues;
          }

          console.log(`      ✓ Updated with aiReasoning`);
          processed++;

          // Wait 2 seconds between API calls to prevent rate limiting
          // Skip delay on last bubble of last page
          if (
            i < bubbles.length - 1 ||
            Array.from(byPage.keys()).indexOf(pageName) < byPage.size - 1
          ) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        } catch (error) {
          console.error(
            `      ❌ Error: ${error instanceof Error ? error.message : String(error)}`,
          );
          errors++;
        }
      }

      console.log(`   ✓ Completed ${pageName}\n`);
    }

    // Save updated cache
    console.log("💾 Saving updated cache...");
    await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
    console.log(`   ✓ Saved to ${CACHE_FILE}\n`);

    // Summary
    console.log("📊 Summary:");
    console.log(`   Processed: ${processed}`);
    console.log(`   Errors: ${errors}`);
    console.log(`   Total needing backfill: ${needsBackfill.length}`);
    console.log("\n✅ Backfill complete!");
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

main();

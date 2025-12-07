#!/usr/bin/env node

/**
 * Sort bubbles in bubbles.json using Gemini AI to determine reading order
 *
 * For each page, sends bubble information to Gemini and asks it to determine
 * the correct reading order based on visual context and narrative flow.
 */

import fs from "fs-extra";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  GoogleGenAI,
  createPartFromText,
  createPartFromBase64,
} from "@google/genai";
import { env } from "~/env.mjs";
import type { Bubble } from "./utils/gemini-context.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

type ContextCache = Record<string, Bubble[]>;

interface BubbleForSorting {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SortingResult {
  orderedIds: string[];
  duplicates?: string[];
  invalid?: string[];
}

/**
 * Parse command-line arguments
 */
function parseArgs(): {
  issue: string;
  page?: string;
  apiKeyName: "GEMINI_API_KEY" | "GEMINI_API_KEY_2";
  dryRun?: boolean;
} {
  const args = process.argv.slice(2);

  // Check for help flag
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage: npm run sort-bubbles-gemini [options]

Options:
  --issue=N, --issue N        Issue number (e.g., --issue=1 for issue-1, default: issue-1)
  --page=N, --page N          Process only a specific page (e.g., --page=03 for page-03.jpg)
  --api-key=KEY               API key to use: "GEMINI_API_KEY" or "GEMINI_API_KEY_2" (default: GEMINI_API_KEY)
  --dry-run                   Show what would be sorted without making changes
  --help, -h                  Show this help message

Examples:
  npm run sort-bubbles-gemini                    Sort all pages in issue-1
  npm run sort-bubbles-gemini --issue=2         Sort all pages in issue-2
  npm run sort-bubbles-gemini --page=03         Sort only page-03.jpg
  npm run sort-bubbles-gemini --dry-run         Preview sorting without saving
`);
    process.exit(0);
  }

  let issue = "issue-1";
  let page: string | undefined;
  let apiKeyName: "GEMINI_API_KEY" | "GEMINI_API_KEY_2" = "GEMINI_API_KEY";
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
    if (arg.startsWith("--page=")) {
      const pageNum = arg.split("=")[1]?.trim();
      if (pageNum) {
        page = pageNum.padStart(2, "0");
      }
    }
    if (arg === "--page") {
      const nextArg = args[i + 1];
      if (nextArg) {
        const pageNum = nextArg.trim();
        page = pageNum.padStart(2, "0");
      }
    }
    if (arg.startsWith("--api-key=")) {
      const keyName = arg.split("=")[1]?.trim();
      if (keyName === "GEMINI_API_KEY" || keyName === "GEMINI_API_KEY_2") {
        apiKeyName = keyName;
      }
    }
    if (arg === "--api-key") {
      const nextArg = args[i + 1];
      if (nextArg) {
        const keyName = nextArg.trim();
        if (keyName === "GEMINI_API_KEY" || keyName === "GEMINI_API_KEY_2") {
          apiKeyName = keyName;
        }
      }
    }
    if (arg === "--dry-run") {
      dryRun = true;
    }
  }

  return { issue, page, apiKeyName, dryRun };
}

/**
 * Get reading order from Gemini
 */
async function getReadingOrderFromGemini(
  gemini: GoogleGenAI,
  pageImage: Buffer,
  bubbles: BubbleForSorting[],
): Promise<SortingResult> {
  const bubblesList = bubbles
    .map(
      (b, i) =>
        `${i + 1}. ID: ${b.id}\n   Text: "${b.text}"\n   Position: (x: ${Math.round(b.x)}, y: ${Math.round(b.y)}, width: ${Math.round(b.width)}, height: ${Math.round(b.height)})`,
    )
    .join("\n\n");

  const prompt = `You are analyzing a comic book page to determine the correct reading order of speech bubbles and text boxes.

**Task:** Given the list of bubbles below, determine the order in which they should be read based on:
1. Visual layout (top-to-bottom, left-to-right reading pattern)
2. Narrative flow and story progression
3. Speech bubble connections and dialogue flow
4. Text box positioning relative to action

**Bubbles to sort:**
${bubblesList}

**Instructions:**
- Analyze the visual layout and determine the natural reading order
- Consider how the text flows narratively
- **IMPORTANT:** If you identify any duplicate bubbles (same text/content appearing multiple times) or invalid bubbles (background text, duplicates, etc.), note them in the "duplicates" or "invalid" arrays
- Return a JSON object with the ordered bubble IDs and any duplicates/invalid bubbles you found

**Output format:**
\`\`\`json
{
  "orderedIds": ["bubble-id-1", "bubble-id-2", "bubble-id-3", ...],
  "duplicates": ["bubble-id-X", "bubble-id-Y"],
  "invalid": ["bubble-id-Z"]
}
\`\`\`

- "orderedIds": Array of bubble IDs in reading order
- "duplicates": Array of bubble IDs that are duplicates (optional, only include if duplicates found)
- "invalid": Array of bubble IDs that should be removed (optional, only include if invalid bubbles found)

Return the bubble IDs in the order they should be read.`;

  try {
    const imagePart = createPartFromBase64(
      pageImage.toString("base64"),
      "image/jpeg",
    );
    const textPart = createPartFromText(prompt);

    const response = await gemini.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [imagePart, textPart],
    });

    const text = response.text;
    if (!text) {
      throw new Error("No text response from Gemini");
    }

    // Extract JSON from response (might be wrapped in markdown code blocks)
    let jsonText = text.trim();
    const jsonMatch = jsonText.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      jsonText = jsonMatch[1]!.trim();
    } else {
      // Try without json tag
      const codeMatch = jsonText.match(/```\s*([\s\S]*?)\s*```/);
      if (codeMatch) {
        jsonText = codeMatch[1]!.trim();
      }
    }

    // Try to extract JSON object pattern
    const objectMatch = jsonText.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      jsonText = objectMatch[0]!;
    }

    let result: SortingResult;
    try {
      result = JSON.parse(jsonText) as SortingResult;
    } catch (parseError) {
      // Fallback: if it's just an array, treat it as orderedIds
      const arrayMatch = jsonText.match(/\[[\s\S]*\]/);
      if (arrayMatch) {
        const orderedIds = JSON.parse(arrayMatch[0]!) as string[];
        result = { orderedIds };
      } else {
        throw new Error(`Failed to parse JSON: ${parseError}`);
      }
    }

    // Validate that all returned bubble IDs are valid
    const bubbleIds = new Set(bubbles.map((b) => b.id));
    const orderedSet = new Set(result.orderedIds);
    const allReturnedIds = new Set([
      ...result.orderedIds,
      ...(result.duplicates || []),
      ...(result.invalid || []),
    ]);

    // Check for invalid IDs in the response
    for (const id of allReturnedIds) {
      if (!bubbleIds.has(id)) {
        throw new Error(`Invalid bubble ID in response: ${id}`);
      }
    }

    // Note: We allow fewer IDs in orderedIds if duplicates/invalid were identified
    // This is expected behavior - Gemini is telling us which bubbles to remove
    const expectedCount = bubbleIds.size;
    const orderedCount = result.orderedIds.length;
    const duplicatesCount = result.duplicates?.length ?? 0;
    const invalidCount = result.invalid?.length ?? 0;

    if (orderedCount + duplicatesCount + invalidCount !== expectedCount) {
      console.warn(
        `⚠️  ID count mismatch: ${expectedCount} input, ${orderedCount} ordered + ${duplicatesCount} duplicates + ${invalidCount} invalid = ${orderedCount + duplicatesCount + invalidCount}`,
      );
    }

    return result;
  } catch (error) {
    console.error(`Error getting reading order from Gemini:`, error);
    throw error;
  }
}

/**
 * Main execution
 */
async function main() {
  try {
    console.log("🔄 Starting AI-powered bubble sorting...\n");

    // Parse arguments
    const { issue, page, apiKeyName, dryRun } = parseArgs();

    // Set up paths
    const COMIC_DIR = join(PROJECT_ROOT, "assets", "comics", "tmnt-mmpr-iii");
    const ISSUE_DIR = join(COMIC_DIR, issue);
    const CACHE_FILE = join(ISSUE_DIR, "bubbles.json");
    const PAGES_DIR = join(ISSUE_DIR, "pages");

    console.log(`📁 Issue: ${issue}`);
    console.log(`📖 Cache: ${CACHE_FILE}`);
    console.log(`🔑 API Key: ${apiKeyName}`);
    if (page) {
      console.log(`🎯 Page: page-${page}.jpg`);
    }
    if (dryRun) {
      console.log(`🔍 Dry run mode - no changes will be saved\n`);
    } else {
      console.log();
    }

    // Initialize Gemini
    const apiKey = env[apiKeyName];
    if (!apiKey) {
      console.error(
        `❌ API key ${apiKeyName} not found in environment variables`,
      );
      process.exit(1);
    }
    const gemini = new GoogleGenAI({ apiKey });

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

    // Filter to specific page if requested
    let pages = Object.keys(cache).sort();
    if (page) {
      const pageKey = `page-${page}.jpg`;
      if (!pages.includes(pageKey)) {
        console.error(`❌ Page ${pageKey} not found in context cache`);
        console.error(`   Available pages: ${pages.join(", ")}`);
        process.exit(1);
      }
      pages = [pageKey];
    }

    // Sort bubbles for each page
    console.log(`🔀 Sorting bubbles using Gemini AI...\n`);
    const sortedCache: ContextCache = { ...cache };
    let totalPages = 0;
    let totalReordered = 0;
    let errors = 0;

    for (const pageName of pages) {
      totalPages++;
      const bubbles = cache[pageName]!;

      if (bubbles.length === 0) {
        console.log(`📄 ${pageName}: No bubbles to sort\n`);
        continue;
      }

      console.log(`📄 ${pageName} (${bubbles.length} bubbles)...`);

      try {
        // Load page image
        const pageImagePath = join(PAGES_DIR, pageName);
        if (!(await fs.pathExists(pageImagePath))) {
          console.error(`   ⚠️  Page image not found: ${pageImagePath}`);
          console.error(`   Skipping this page\n`);
          errors++;
          continue;
        }

        const pageImage = await fs.readFile(pageImagePath);

        // Prepare bubble data for Gemini
        const bubblesForSorting: BubbleForSorting[] = bubbles.map((b) => ({
          id: b.id,
          text: b.textWithCues || b.ocr_text,
          x: b.box_2d.x ?? 0,
          y: b.box_2d.y ?? 0,
          width: b.box_2d.width ?? 0,
          height: b.box_2d.height ?? 0,
        }));

        // Get reading order from Gemini
        const sortingResult = await getReadingOrderFromGemini(
          gemini,
          pageImage,
          bubblesForSorting,
        );

        // Log duplicates/invalid bubbles if found
        if (sortingResult.duplicates && sortingResult.duplicates.length > 0) {
          console.log(
            `   ⚠️  Duplicates identified: ${sortingResult.duplicates.join(", ")}`,
          );
        }
        if (sortingResult.invalid && sortingResult.invalid.length > 0) {
          console.log(
            `   ⚠️  Invalid bubbles identified: ${sortingResult.invalid.join(", ")}`,
          );
        }

        // Reorder bubbles (only include those in orderedIds)
        const bubbleMap = new Map(bubbles.map((b) => [b.id, b]));
        const sortedBubbles = sortingResult.orderedIds
          .map((id) => bubbleMap.get(id))
          .filter((b): b is Bubble => b !== undefined);

        // Mark duplicates and invalid bubbles as ignored
        const bubblesToIgnore = new Set([
          ...(sortingResult.duplicates || []),
          ...(sortingResult.invalid || []),
        ]);

        if (bubblesToIgnore.size > 0) {
          console.log(
            `   🗑️  Marking ${bubblesToIgnore.size} bubble(s) as ignored`,
          );
          // Update the cache to mark these as ignored
          for (const bubble of sortedBubbles) {
            if (bubblesToIgnore.has(bubble.id)) {
              bubble.ignored = true;
            }
          }
        }

        // Renumber bubble IDs to match their sorted order
        // Extract page number from first bubble ID (e.g., "page-03_b01" -> "page-03")
        const pagePrefix = sortedBubbles[0]?.id.match(/^(page-\d+)/)?.[1];
        if (pagePrefix) {
          sortedBubbles.forEach((bubble, index) => {
            const newId = `${pagePrefix}_b${String(index + 1).padStart(2, "0")}`;
            if (bubble.id !== newId) {
              console.log(`   🔄 Renumbering: ${bubble.id} → ${newId}`);
              bubble.id = newId;
              // Also update the index in box_2d if it exists (box_2d may have extra properties)
              const box2d = bubble.box_2d as typeof bubble.box_2d & {
                index?: number;
              };
              if (box2d) {
                box2d.index = index;
              }
            }
          });
        }

        // Check if order changed
        const orderChanged = sortedBubbles.some(
          (b, i) => b.id !== bubbles[i]?.id,
        );

        if (orderChanged) {
          totalReordered++;
          console.log(`   Original: ${bubbles.map((b) => b.id).join(", ")}`);
          console.log(
            `   Sorted:   ${sortedBubbles.map((b) => b.id).join(", ")}`,
          );
          sortedCache[pageName] = sortedBubbles;
        } else {
          console.log(`   ✓ Already in correct order`);
        }

        // Wait 2 seconds between API calls to prevent rate limiting
        if (totalPages < pages.length) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }

        console.log();
      } catch (error) {
        console.error(
          `   ❌ Error: ${error instanceof Error ? error.message : String(error)}`,
        );
        errors++;
        console.log();
      }
    }

    // Summary
    console.log("📊 Summary:");
    console.log(`   Total pages: ${totalPages}`);
    console.log(`   Pages reordered: ${totalReordered}`);
    console.log(`   Errors: ${errors}`);

    // Save if not dry run
    if (!dryRun && totalReordered > 0) {
      console.log("\n💾 Saving sorted context cache...");
      await fs.writeFile(CACHE_FILE, JSON.stringify(sortedCache, null, 2));
      console.log(`   ✓ Saved to ${CACHE_FILE}\n`);
      console.log("✅ Bubble sorting complete!");
    } else if (dryRun) {
      console.log("\n🔍 Dry run complete - no changes were saved");
      console.log("   Run without --dry-run to apply changes");
    } else {
      console.log("\n✅ All pages already in correct order!");
    }
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

main();

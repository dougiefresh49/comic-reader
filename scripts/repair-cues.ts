#!/usr/bin/env node

/**
 * Repair textWithCues field for each bubble using Gemini 2.5 Flash
 *
 * For each bubble, sends bubble data and ElevenLabs documentation to Gemini
 * and asks it to correct the textWithCues field according to the documentation.
 */

import fs from "fs-extra";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI, createPartFromText } from "@google/genai";
import { env } from "~/env.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

type ContextCache = Record<string, Bubble[]>;

interface Bubble {
  id: string;
  box_2d: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    index?: number;
    [key: string]: unknown;
  };
  ocr_text: string;
  type: "SPEECH" | "NARRATION" | "CAPTION" | "SFX" | "BACKGROUND";
  speaker: string | null;
  emotion: string;
  characterType?: "MAJOR" | "MINOR" | "EXTRA";
  side?: "HERO" | "VILLAIN" | "NEUTRAL";
  voiceDescription?: string;
  textWithCues?: string;
  aiReasoning?: string;
  ignored?: boolean;
  style?: {
    left: string;
    top: string;
    width: string;
    height: string;
  };
}

/**
 * Parse command-line arguments
 */
function parseArgs(): {
  issue: string;
  apiKeyName: "GEMINI_API_KEY" | "GEMINI_API_KEY_2";
  page?: string;
  dryRun?: boolean;
} {
  const args = process.argv.slice(2);

  // Check for help flag
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage: npm run repair-cues [options]

Options:
  --issue=N, --issue N        Issue number (e.g., --issue=1 for issue-1, default: issue-1)
  --page=N, --page N          Process only a specific page (e.g., --page=03 for page-03.jpg)
  --api-key=KEY               API key to use: "GEMINI_API_KEY" or "GEMINI_API_KEY_2" (default: GEMINI_API_KEY)
  --dry-run                   Show what would be repaired without making changes
  --help, -h                  Show this help message

Examples:
  npm run repair-cues                              Repair all bubbles in issue-1
  npm run repair-cues --issue=2                   Repair all bubbles in issue-2
  npm run repair-cues --page=03                   Repair only page-03.jpg
  npm run repair-cues --dry-run                   Preview repairs without saving
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
 * Extract baseline text from textWithCues by removing audio tags
 */
function extractBaselineText(textWithCues: string): string {
  // Remove audio tags in square brackets like [whispers], [laughs], etc.
  // This regex matches [anything] patterns
  return textWithCues
    .replace(/\[.*?\]/g, "")
    .trim()
    .replace(/\s+/g, " "); // Normalize whitespace
}

/**
 * Compare two texts and determine if they're significantly different
 * Returns true if texts differ beyond just punctuation/capitalization
 */
function textsDiffer(text1: string, text2: string): boolean {
  // Normalize both texts for comparison
  const normalize = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, "") // Remove punctuation
      .replace(/\s+/g, " ")
      .trim();

  return normalize(text1) !== normalize(text2);
}

/**
 * Read the ElevenLabs documentation markdown file
 */
async function loadElevenLabsDocs(): Promise<string> {
  const docsPath = join(
    PROJECT_ROOT,
    "docs",
    "prompting-elevenlabs-v3-with-emotion.md",
  );
  try {
    const content = await fs.readFile(docsPath, "utf-8");
    return content;
  } catch (error) {
    console.error(`❌ Failed to load ElevenLabs documentation: ${error}`);
    console.error(`   Expected at: ${docsPath}`);
    throw error;
  }
}

/**
 * Repair a single bubble's textWithCues using Gemini
 */
async function repairBubbleCues(
  gemini: GoogleGenAI,
  bubble: Bubble,
  elevenLabsDocs: string,
): Promise<string> {
  const prompt = `You are an expert prompt engineer for ElevenLabs v3 Text-to-Speech.

Your task is to fix the formatting of a text prompt to ensure it produces the best possible audio output, strictly following the provided documentation.

**Documentation Reference:**
${elevenLabsDocs}

**Input Data:**

- Original OCR Text: "${bubble.ocr_text}"
- Current Text with Cues Audio Prompt: "${bubble.textWithCues || bubble.ocr_text}"
- Character: ${bubble.speaker || "Unknown"}
- Emotion: ${bubble.emotion || "Unknown"}
- Character Type: ${bubble.characterType || "Unknown"}
- Side: ${bubble.side || "Unknown"}
- Voice Description: ${bubble.voiceDescription || "Not provided"}
- Context/Reasoning: ${bubble.aiReasoning || "Not provided"}

**Instructions:**
1.  **Analyze the "Current Text with Cues Audio Prompt"**: Identify any tags or formatting that violate the documentation or would lead to poor audio (e.g., "stage directions" that describe physical actions instead of sound, invalid tag formats).
2.  **Fix the Prompt**: Rewrite the prompt to be compliant. 
    - Convert physical actions (e.g., "[shaking head]") to auditory equivalents (e.g., "[sighs]") or remove them if they don't add audio value.
    - Ensure tags are in square brackets \`[]\`.
    - Use standard punctuation for pacing (ellipses \`...\` for pauses). 
    - **CRITICAL:** Do NOT use the word "pause" in brackets (e.g., \`[pause]\`). Use \`...\` or \`[short pause]\` / \`[long pause]\` ONLY if the docs explicitly support it (the docs mention these for v3). If in doubt, use ellipses. 
3.  **Preserve Intent**: Keep the emotional intent and the original dialogue text.
4.  **Discrepancies**: If the "Current Text with Cues Audio Prompt" without the audio tags is different from the "Original OCR Text", then assume the "Current Text with Cues Audio Prompt" is the most accurate and to be used for the baseline to apply the audio tags to.
5.  **Output**: Return ONLY the fixed prompt string. Do not include any explanation or markdown.
`;

  try {
    const textPart = createPartFromText(prompt);

    const response = await gemini.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [textPart],
    });

    const text = response.text;
    if (!text) {
      throw new Error("No text response from Gemini");
    }

    // Clean up the response - remove markdown code blocks if present
    let cleanedText = text.trim();
    const codeBlockMatch = cleanedText.match(/```[\w]*\n?([\s\S]*?)\n?```/);
    if (codeBlockMatch) {
      cleanedText = codeBlockMatch[1]!.trim();
    }

    // Remove any quotes if the response is wrapped in them
    cleanedText = cleanedText.replace(/^["']|["']$/g, "");

    return cleanedText;
  } catch (error) {
    console.error(`Error repairing bubble ${bubble.id}:`, error);
    throw error;
  }
}

/**
 * Main execution
 */
async function main() {
  try {
    console.log("🔧 Starting textWithCues repair script...\n");

    // Parse arguments
    const { issue, page, apiKeyName, dryRun } = parseArgs();

    // Set up paths
    const COMIC_DIR = join(PROJECT_ROOT, "assets", "comics", "tmnt-mmpr-iii");
    const ISSUE_DIR = join(COMIC_DIR, issue);
    const CACHE_FILE = join(ISSUE_DIR, "bubbles.json");

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

    // Load ElevenLabs documentation
    console.log("📚 Loading ElevenLabs documentation...");
    const elevenLabsDocs = await loadElevenLabsDocs();
    console.log(
      `   ✓ Loaded documentation (${elevenLabsDocs.length} characters)\n`,
    );

    // Load context cache
    console.log("📖 Loading bubbles cache...");
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

    // Filter to specific page if requested
    let pages = Object.keys(cache).sort();
    if (page) {
      const pageKey = `page-${page}.jpg`;
      if (!pages.includes(pageKey)) {
        console.error(`❌ Page ${pageKey} not found in cache`);
        console.error(`   Available pages: ${pages.join(", ")}`);
        process.exit(1);
      }
      pages = [pageKey];
    }

    // Repair bubbles for each page
    console.log(`🔧 Repairing textWithCues using Gemini AI...\n`);
    const repairedCache: ContextCache = { ...cache };
    let totalPages = 0;
    let totalBubbles = 0;
    let repairedCount = 0;
    let ocrTextUpdatedCount = 0;
    let errors = 0;

    for (const pageName of pages) {
      totalPages++;
      const bubbles = cache[pageName]!;

      if (bubbles.length === 0) {
        console.log(`📄 ${pageName}: No bubbles to repair\n`);
        continue;
      }

      console.log(`📄 ${pageName} (${bubbles.length} bubbles)...`);

      const repairedBubbles: Bubble[] = [];
      let pageRepaired = 0;
      let pageOcrUpdated = 0;

      for (let i = 0; i < bubbles.length; i++) {
        const bubble = bubbles[i]!;
        totalBubbles++;

        // Skip ignored bubbles
        if (bubble.ignored) {
          repairedBubbles.push(bubble);
          continue;
        }

        const textPreview =
          bubble.ocr_text.slice(0, 50) +
          (bubble.ocr_text.length > 50 ? "..." : "");

        console.log(
          `   [${i + 1}/${bubbles.length}] Repairing: "${textPreview}"`,
        );

        try {
          // Step 1: Update OCR text if baseline from textWithCues is more accurate
          let ocrWasUpdated = false;
          if (bubble.textWithCues) {
            const baselineText = extractBaselineText(bubble.textWithCues);

            // Check if baseline differs from OCR text (beyond just punctuation/capitalization)
            if (baselineText && textsDiffer(baselineText, bubble.ocr_text)) {
              // Baseline text is likely more accurate (it was manually corrected or verified)
              console.log(`      🔄 Updating OCR text:`);
              console.log(`         Old: "${bubble.ocr_text}"`);
              console.log(`         New: "${baselineText}"`);
              bubble.ocr_text = baselineText;
              ocrTextUpdatedCount++;
              pageOcrUpdated++;
              ocrWasUpdated = true;
            }
          }

          // Step 2: Repair textWithCues with updated OCR text (if it changed)
          const originalCues = bubble.textWithCues || bubble.ocr_text;
          const repairedCues = await repairBubbleCues(
            gemini,
            bubble,
            elevenLabsDocs,
          );

          // Step 3: Check if the cues actually changed
          if (originalCues !== repairedCues) {
            console.log(`      ✏️  Repaired textWithCues:`);
            console.log(`         Before: "${originalCues}"`);
            console.log(`         After:  "${repairedCues}"`);
            pageRepaired++;
            repairedCount++;

            // Update the bubble
            bubble.textWithCues = repairedCues;

            // Step 4: After repair, update OCR text again if the new baseline differs
            const newBaselineText = extractBaselineText(repairedCues);
            if (
              newBaselineText &&
              textsDiffer(newBaselineText, bubble.ocr_text)
            ) {
              // Only update if it's actually different from what we already set
              if (newBaselineText !== bubble.ocr_text) {
                console.log(`      🔄 Updating OCR text after repair:`);
                console.log(`         Old: "${bubble.ocr_text}"`);
                console.log(`         New: "${newBaselineText}"`);
                bubble.ocr_text = newBaselineText;
                // Don't double-count if we already updated it above
                if (!ocrWasUpdated) {
                  ocrTextUpdatedCount++;
                  pageOcrUpdated++;
                }
              }
            }
          } else {
            console.log(`      ✓ No changes needed`);
          }

          repairedBubbles.push(bubble);

          // Wait 1 second between API calls to prevent rate limiting
          // Skip delay on last bubble of last page
          if (
            i < bubbles.length - 1 ||
            pages.indexOf(pageName) < pages.length - 1
          ) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        } catch (error) {
          console.error(
            `      ❌ Error: ${error instanceof Error ? error.message : String(error)}`,
          );
          errors++;
          // Keep the original bubble even on error
          repairedBubbles.push(bubble);
        }
      }

      // Save the page if any repairs or OCR updates were made
      if (pageRepaired > 0 || pageOcrUpdated > 0) {
        repairedCache[pageName] = repairedBubbles;
        const updates: string[] = [];
        if (pageRepaired > 0) {
          updates.push(`${pageRepaired} textWithCues repaired`);
        }
        if (pageOcrUpdated > 0) {
          updates.push(`${pageOcrUpdated} OCR texts updated`);
        }
        console.log(`   ✓ ${updates.join(", ")} on this page`);
      } else {
        console.log(`   ✓ No bubbles needed repair on this page`);
      }

      console.log();
    }

    // Summary
    console.log("📊 Summary:");
    console.log(`   Total pages: ${totalPages}`);
    console.log(`   Total bubbles: ${totalBubbles}`);
    console.log(`   OCR text updated: ${ocrTextUpdatedCount}`);
    console.log(`   textWithCues repaired: ${repairedCount}`);
    console.log(`   Errors: ${errors}`);

    // Save if not dry run and we made any changes
    if (!dryRun && (repairedCount > 0 || ocrTextUpdatedCount > 0)) {
      console.log("\n💾 Saving repaired cache...");
      await fs.writeFile(CACHE_FILE, JSON.stringify(repairedCache, null, 2));
      console.log(`   ✓ Saved to ${CACHE_FILE}\n`);
      console.log("✅ Repair complete!");
    } else if (dryRun) {
      console.log("\n🔍 Dry run complete - no changes were saved");
      console.log("   Run without --dry-run to apply changes");
    } else {
      console.log(
        "\n✅ All bubbles already have correct textWithCues and OCR text!",
      );
    }
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

main();

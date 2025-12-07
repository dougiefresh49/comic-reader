#!/usr/bin/env node

/**
 * Regenerate timestamps for existing audio files
 *
 * Re-calls the ElevenLabs API for each bubble to get timestamps
 * without regenerating the audio files themselves.
 * This is useful if timestamps were missing from the original generation.
 */

import fs from "fs-extra";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { env } from "~/env.mjs";
import { getCanonicalName } from "./alias-map.js";
import type { Bubble } from "./utils/gemini-context.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

type ContextCache = Record<string, Bubble[]>;

interface CharacterAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

interface AudioTimestamps {
  alignment: CharacterAlignment | null;
  normalized_alignment: CharacterAlignment | null;
}

type TimestampsMap = Record<string, AudioTimestamps>;
type CastList = Record<string, string>;

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(str1: string, str2: string): number {
  const len1 = str1.length;
  const len2 = str2.length;
  const matrix: number[][] = [];

  // Initialize matrix
  for (let i = 0; i <= len1; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= len2; j++) {
    matrix[0]![j] = j;
  }

  // Fill matrix
  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        matrix[i]![j] = matrix[i - 1]![j - 1]!;
      } else {
        matrix[i]![j] = Math.min(
          matrix[i - 1]![j]! + 1, // deletion
          matrix[i]![j - 1]! + 1, // insertion
          matrix[i - 1]![j - 1]! + 1, // substitution
        );
      }
    }
  }

  return matrix[len1]![len2]!;
}

/**
 * Find fuzzy match for character name in castlist
 */
function findFuzzyMatch(
  normalizedName: string,
  castList: CastList,
): string | null {
  const threshold = 3; // Maximum edit distance
  let bestMatch: string | null = null;
  let bestDistance = Infinity;

  for (const castName of Object.keys(castList)) {
    const distance = levenshteinDistance(normalizedName, castName);
    if (distance < bestDistance && distance <= threshold) {
      bestDistance = distance;
      bestMatch = castName;
    }
  }

  return bestMatch;
}

/**
 * Get voice ID for a character name
 */
function getVoiceId(
  characterName: string | null,
  castList: CastList,
): { voiceId: string; matchedName: string; isFuzzy: boolean } {
  if (!characterName) {
    return {
      voiceId: castList["Narrator"]!,
      matchedName: "Narrator",
      isFuzzy: false,
    };
  }

  const normalizedName = getCanonicalName(characterName);

  // Direct lookup
  if (castList[normalizedName]) {
    return {
      voiceId: castList[normalizedName]!,
      matchedName: normalizedName,
      isFuzzy: false,
    };
  }

  // Try fuzzy matching
  const fuzzyMatch = findFuzzyMatch(normalizedName, castList);
  if (fuzzyMatch) {
    return {
      voiceId: castList[fuzzyMatch]!,
      matchedName: fuzzyMatch,
      isFuzzy: true,
    };
  }

  // Default to Narrator
  return {
    voiceId: castList["Narrator"]!,
    matchedName: "Narrator",
    isFuzzy: false,
  };
}

/**
 * Parse command-line arguments
 */
function parseArgs(): { issue: string; page?: string } {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage: npm run regenerate-timestamps [options]

Options:
  --issue=N, --issue N        Issue number (e.g., --issue=1 for issue-1, default: issue-1)
  --page=N, --page N          Process only a specific page (e.g., --page=03)
  --help, -h                  Show this help message

Examples:
  npm run regenerate-timestamps                    Regenerate for all pages in issue-1
  npm run regenerate-timestamps --issue=2         Regenerate for all pages in issue-2
  npm run regenerate-timestamps --page=03         Regenerate only page-03.jpg
`);
    process.exit(0);
  }

  let issue = "issue-1";
  let page: string | undefined;

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
  }

  return { issue, page };
}

/**
 * Main execution
 */
async function main() {
  try {
    console.log("⏱️  Starting timestamp regeneration...\n");

    // Parse arguments
    const { issue, page } = parseArgs();

    // Set up paths
    const COMIC_DIR = join(PROJECT_ROOT, "assets", "comics", "tmnt-mmpr-iii");
    const ISSUE_DIR = join(COMIC_DIR, issue);
    const CACHE_FILE = join(ISSUE_DIR, "bubbles.json");
    const CASTLIST_FILE = join(COMIC_DIR, "castlist.json");
    const AUDIO_DIR = join(ISSUE_DIR, "audio");
    const TIMESTAMPS_FILE = join(ISSUE_DIR, "audio-timestamps.json");

    console.log(`📁 Issue: ${issue}`);
    if (page) {
      console.log(`🎯 Page: page-${page}.jpg`);
    }
    console.log();

    // Check API key
    const apiKey = env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      console.error("❌ ELEVENLABS_API_KEY not found in environment variables");
      process.exit(1);
    }

    // Initialize ElevenLabs client
    const client = new ElevenLabsClient({
      apiKey,
      environment: "https://api.elevenlabs.io",
    });

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
      process.exit(1);
    }

    // Load castlist
    console.log("🎭 Loading castlist...");
    let castList: CastList = {};
    try {
      const existing = await fs.readFile(CASTLIST_FILE, "utf-8");
      castList = JSON.parse(existing) as CastList;
      console.log(`   ✓ Loaded ${Object.keys(castList).length} voice models\n`);
    } catch (error) {
      console.error(`❌ Failed to load castlist: ${error}`);
      process.exit(1);
    }

    // Verify Narrator exists
    if (!castList["Narrator"]) {
      console.error(
        "❌ Narrator voice not found in castlist (required as fallback)",
      );
      process.exit(1);
    }

    // Load existing timestamps (to preserve what we have)
    let existingTimestamps: TimestampsMap = {};
    if (await fs.pathExists(TIMESTAMPS_FILE)) {
      try {
        const existing = await fs.readFile(TIMESTAMPS_FILE, "utf-8");
        existingTimestamps = JSON.parse(existing) as TimestampsMap;
        console.log(
          `   ✓ Loaded existing timestamps for ${Object.keys(existingTimestamps).length} bubbles\n`,
        );
      } catch (error) {
        console.warn(`   ⚠️  Could not load existing timestamps: ${error}`);
      }
    }

    // Filter pages
    let pages = Object.keys(cache).sort();
    if (page) {
      const pageKey = `page-${page}.jpg`;
      if (!pages.includes(pageKey)) {
        console.error(`❌ Page ${pageKey} not found`);
        process.exit(1);
      }
      pages = [pageKey];
    }

    // Process each page
    console.log(`🔄 Regenerating timestamps...\n`);
    const timestamps: TimestampsMap = { ...existingTimestamps };
    let processed = 0;
    let skipped = 0;
    let errors = 0;

    for (const pageName of pages) {
      const bubbles = cache[pageName]!;
      console.log(`📄 ${pageName} (${bubbles.length} bubbles)`);

      for (const bubble of bubbles) {
        // Skip ignored bubbles
        if (bubble.ignored) {
          skipped++;
          continue;
        }

        // Check if audio file exists
        const audioPath = join(AUDIO_DIR, `${bubble.id}.mp3`);
        if (!(await fs.pathExists(audioPath))) {
          console.log(`   ⏭️  Skipped ${bubble.id} (no audio file)`);
          skipped++;
          continue;
        }

        // Check if we already have complete timestamps
        const existing = timestamps[bubble.id];
        if (
          existing?.alignment?.character_start_times_seconds?.length &&
          existing?.alignment?.character_end_times_seconds?.length
        ) {
          console.log(`   ✓ ${bubble.id} (already has timestamps)`);
          processed++;
          continue;
        }

        // Get text and voice ID
        const textToUse = bubble.textWithCues || bubble.ocr_text;
        if (!textToUse || textToUse.trim().length === 0) {
          skipped++;
          continue;
        }

        // Get voice ID using the same logic as generate-audio.ts
        const { voiceId } = getVoiceId(bubble.speaker, castList);

        try {
          console.log(`   [${processed + 1}] Regenerating ${bubble.id}...`);

          // Call API to get timestamps (without saving audio)
          const response = await client.textToSpeech.convertWithTimestamps(
            voiceId,
            {
              text: textToUse,
            },
          );

          // Extract timestamps - handle both snake_case and camelCase
          const alignment = response.alignment as
            | {
                characters?: string[];
                character_start_times_seconds?: number[];
                character_end_times_seconds?: number[];
                characterStartTimesSeconds?: number[];
                characterEndTimesSeconds?: number[];
              }
            | null
            | undefined;

          const normalizedAlignment = response.normalizedAlignment as
            | {
                characters?: string[];
                character_start_times_seconds?: number[];
                character_end_times_seconds?: number[];
                characterStartTimesSeconds?: number[];
                characterEndTimesSeconds?: number[];
              }
            | null
            | undefined;

          timestamps[bubble.id] = {
            alignment: alignment
              ? {
                  characters: alignment.characters ?? [],
                  character_start_times_seconds:
                    alignment.character_start_times_seconds ??
                    alignment.characterStartTimesSeconds ??
                    [],
                  character_end_times_seconds:
                    alignment.character_end_times_seconds ??
                    alignment.characterEndTimesSeconds ??
                    [],
                }
              : null,
            normalized_alignment: normalizedAlignment
              ? {
                  characters: normalizedAlignment.characters ?? [],
                  character_start_times_seconds:
                    normalizedAlignment.character_start_times_seconds ??
                    normalizedAlignment.characterStartTimesSeconds ??
                    [],
                  character_end_times_seconds:
                    normalizedAlignment.character_end_times_seconds ??
                    normalizedAlignment.characterEndTimesSeconds ??
                    [],
                }
              : null,
          };

          processed++;

          // Wait 500ms between API calls
          if (processed < bubbles.length) {
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        } catch (error) {
          console.error(
            `      ❌ Error: ${error instanceof Error ? error.message : String(error)}`,
          );
          errors++;
        }
      }

      console.log();
    }

    // Save timestamps
    console.log("💾 Saving timestamps...");
    await fs.writeFile(
      TIMESTAMPS_FILE,
      JSON.stringify(timestamps, null, 2),
    );
    console.log(`   ✓ Saved to ${TIMESTAMPS_FILE}\n`);

    // Summary
    console.log("📊 Summary:");
    console.log(`   Processed: ${processed}`);
    console.log(`   Skipped: ${skipped}`);
    console.log(`   Errors: ${errors}`);
    console.log("\n✅ Timestamp regeneration complete!");
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

main();


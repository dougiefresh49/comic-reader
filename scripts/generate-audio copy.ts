#!/usr/bin/env node

/**
 * Generate audio files for all bubbles in bubbles.json
 *
 * For each bubble:
 * 1. Normalize character name using alias-map
 * 2. Look up voice ID in castlist.json
 * 3. If not found, try fuzzy matching
 * 4. If still not found, default to Narrator
 * 5. Generate audio using ElevenLabs Text-to-Speech API with timestamps
 * 6. Save audio file using bubble ID
 *
 * Tracks failed matches in no-match-characters.json
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
type CastList = Record<string, string>;
type NoMatchEntry = {
  characterName: string;
  normalizedName: string;
  bubbleId: string;
  pageName: string;
};

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
 * Calculate similarity score between two strings (0-1, higher is more similar)
 */
function stringSimilarity(str1: string, str2: string): number {
  const maxLen = Math.max(str1.length, str2.length);
  if (maxLen === 0) return 1;
  const distance = levenshteinDistance(str1.toLowerCase(), str2.toLowerCase());
  return 1 - distance / maxLen;
}

/**
 * Find best fuzzy match for a character name in castlist
 */
function findFuzzyMatch(
  characterName: string,
  castList: CastList,
  threshold = 0.6,
): string | null {
  const normalized = characterName.toLowerCase().trim();
  let bestMatch: { name: string; score: number } | null = null;

  for (const castName of Object.keys(castList)) {
    const score = stringSimilarity(normalized, castName.toLowerCase());
    if (score >= threshold && (!bestMatch || score > bestMatch.score)) {
      bestMatch = { name: castName, score };
    }
  }

  return bestMatch ? bestMatch.name : null;
}

/**
 * Map emotion string to voice settings for overall tone
 * Adjusts stability and style based on emotional intensity
 */
function getVoiceSettingsFromEmotion(emotion: string): {
  stability?: number;
  similarityBoost?: number;
  style?: number;
  speed?: number;
} {
  const lowerEmotion = emotion.toLowerCase().trim();

  // Default settings (balanced)
  let stability = 0.5;
  let style = 0.0;
  let speed = 1.0;

  // High intensity emotions - lower stability for more expressiveness
  if (
    lowerEmotion.includes("angry") ||
    lowerEmotion.includes("furious") ||
    lowerEmotion.includes("rage") ||
    lowerEmotion.includes("shouting") ||
    lowerEmotion.includes("screaming") ||
    lowerEmotion.includes("yelling")
  ) {
    stability = 0.3; // More expressive
    style = 0.3; // More style exaggeration
    speed = 1.1; // Slightly faster
  }
  // Sad/depressed emotions
  else if (
    lowerEmotion.includes("sad") ||
    lowerEmotion.includes("depressed") ||
    lowerEmotion.includes("melancholy") ||
    lowerEmotion.includes("distraught") ||
    lowerEmotion.includes("upset")
  ) {
    stability = 0.4; // More expressive
    style = 0.2;
    speed = 0.9; // Slightly slower
  }
  // Excited/happy emotions
  else if (
    lowerEmotion.includes("excited") ||
    lowerEmotion.includes("enthusiastic") ||
    lowerEmotion.includes("happy") ||
    lowerEmotion.includes("joyful") ||
    lowerEmotion.includes("ecstatic")
  ) {
    stability = 0.4; // More expressive
    style = 0.3;
    speed = 1.1; // Slightly faster
  }
  // Fearful/anxious emotions
  else if (
    lowerEmotion.includes("fear") ||
    lowerEmotion.includes("afraid") ||
    lowerEmotion.includes("anxious") ||
    lowerEmotion.includes("nervous") ||
    lowerEmotion.includes("terrified")
  ) {
    stability = 0.35; // More expressive
    style = 0.25;
    speed = 1.05; // Slightly faster
  }
  // Whispering/quiet
  else if (
    lowerEmotion.includes("whisper") ||
    lowerEmotion.includes("quiet") ||
    lowerEmotion.includes("hushed")
  ) {
    stability = 0.5;
    style = 0.1;
    speed = 0.95; // Slightly slower
  }
  // Stoic/calm/neutral
  else if (
    lowerEmotion.includes("stoic") ||
    lowerEmotion.includes("calm") ||
    lowerEmotion.includes("neutral") ||
    lowerEmotion.includes("firm") ||
    lowerEmotion.includes("defiant")
  ) {
    stability = 0.6; // More stable/consistent
    style = 0.0; // Less style
    speed = 1.0; // Normal speed
  }
  // Sarcastic/mocking
  else if (
    lowerEmotion.includes("sarcastic") ||
    lowerEmotion.includes("mocking") ||
    lowerEmotion.includes("snide")
  ) {
    stability = 0.4;
    style = 0.3;
    speed = 1.0;
  }
  // Surprised/shocked
  else if (
    lowerEmotion.includes("surprised") ||
    lowerEmotion.includes("shocked") ||
    lowerEmotion.includes("astonished")
  ) {
    stability = 0.35;
    style = 0.3;
    speed = 1.05;
  }

  return {
    stability,
    similarityBoost: 0.75, // Keep voice similarity
    style,
    speed,
  };
}

/**
 * Convert Gemini cues to ElevenLabs-compatible audio tags
 * Removes invalid cues and maps common patterns to valid tags
 */
function convertCuesToElevenLabsTags(text: string): string {
  // Remove all bracket-enclosed cues that aren't valid ElevenLabs tags
  // Valid ElevenLabs v3 tags (from documentation):
  const validTags = new Set([
    // Emotional/directional
    "happy",
    "sad",
    "excited",
    "angry",
    "annoyed",
    "appalled",
    "thoughtful",
    "surprised",
    "sarcastic",
    "curious",
    "crying",
    "mischievously",
    // Voice-related
    "whispers",
    "whisper",
    "laughs",
    "laughing",
    "laughs harder",
    "starts laughing",
    "wheezing",
    "sighs",
    "sigh",
    "exhales",
    "exhales sharply",
    "inhales deeply",
    "clears throat",
    "chuckles",
    "giggles",
    // Sound effects
    "gunshot",
    "applause",
    "clapping",
    "explosion",
    "swallows",
    "gulps",
    // Pauses
    "short pause",
    "long pause",
    "pauses",
    "pause",
    // Special
    "sings",
    "woo",
    "fart",
    // Shouting variations
    "shouting",
    "shout",
    "screaming",
    "scream",
  ]);

  // Extract all bracket-enclosed cues
  const cuePattern = /\[([^\]]+)\]/g;
  const cues: string[] = [];
  let match;
  while ((match = cuePattern.exec(text)) !== null) {
    cues.push(match[1]!);
  }

  // Filter and convert cues
  const validCues: string[] = [];
  for (const cue of cues) {
    const lowerCue = cue.toLowerCase().trim();

    // Check if it's a valid tag (exact match or contains valid tag)
    let isValid = false;
    let mappedTag: string | null = null;

    // Direct match
    if (validTags.has(lowerCue)) {
      isValid = true;
      mappedTag = lowerCue;
    } else {
      // Try to map common patterns
      if (lowerCue.includes("whisper") || lowerCue.includes("quiet")) {
        mappedTag = "whispers";
        isValid = true;
      } else if (
        lowerCue.includes("shout") ||
        lowerCue.includes("yell") ||
        lowerCue.includes("scream")
      ) {
        mappedTag = "shouting";
        isValid = true;
      } else if (lowerCue.includes("laugh") || lowerCue.includes("chuckle")) {
        mappedTag = "laughs";
        isValid = true;
      } else if (lowerCue.includes("sigh") || lowerCue.includes("exhale")) {
        mappedTag = "sighs";
        isValid = true;
      } else if (
        lowerCue.includes("sarcastic") ||
        lowerCue.includes("sarcasm")
      ) {
        mappedTag = "sarcastic";
        isValid = true;
      } else if (
        lowerCue.includes("angry") ||
        lowerCue.includes("mad") ||
        lowerCue.includes("furious")
      ) {
        mappedTag = "angry";
        isValid = true;
      } else if (
        lowerCue.includes("sad") ||
        lowerCue.includes("upset") ||
        lowerCue.includes("distraught")
      ) {
        mappedTag = "sad";
        isValid = true;
      } else if (
        lowerCue.includes("excited") ||
        lowerCue.includes("enthusiastic")
      ) {
        mappedTag = "excited";
        isValid = true;
      } else if (lowerCue.includes("happy") || lowerCue.includes("joyful")) {
        mappedTag = "happy";
        isValid = true;
      } else if (
        lowerCue.includes("surprised") ||
        lowerCue.includes("shocked")
      ) {
        mappedTag = "surprised";
        isValid = true;
      } else if (lowerCue.includes("pause") || lowerCue.includes("wait")) {
        mappedTag = "short pause";
        isValid = true;
      }
    }

    if (isValid && mappedTag) {
      validCues.push(mappedTag);
    }
  }

  // Remove all bracket-enclosed text
  let cleanedText = text.replace(/\[([^\]]+)\]/g, "").trim();

  // Add valid cues at the beginning
  if (validCues.length > 0) {
    const tagsString = validCues.map((tag) => `[${tag}]`).join(" ");
    cleanedText = `${tagsString} ${cleanedText}`.trim();
  }

  // Clean up extra whitespace
  cleanedText = cleanedText.replace(/\s+/g, " ").trim();

  return cleanedText;
}

/**
 * Get voice ID for a character name
 */
function getVoiceId(
  characterName: string | null,
  castList: CastList,
): { voiceId: string; matchedName: string; isFuzzy: boolean } {
  // If no speaker, default to Narrator
  if (!characterName) {
    return {
      voiceId: castList["Narrator"]!,
      matchedName: "Narrator",
      isFuzzy: false,
    };
  }

  // Normalize using alias map
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

  // Check for help flag
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage: npm run generate-audio [options]

Options:
  --issue=N, --issue N        Issue number (e.g., --issue=2 for issue-2, default: issue-2)
  --page=N, --page N          Process only a specific page (e.g., --page=06 for page-06.jpg)
  --help, -h                  Show this help message

Examples:
  npm run generate-audio                    Generate audio for all pages in issue-2
  npm run generate-audio --issue=1         Generate audio for all pages in issue-1
  npm run generate-audio --page=06         Generate audio for page-06.jpg only
  npm run generate-audio --issue=1 --page=03  Generate audio for page-03.jpg in issue-1
`);
    process.exit(0);
  }

  let issue = "issue-2";
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
        // Normalize page number (e.g., "6" -> "06", "06" -> "06")
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
    console.log("🎙️  Starting audio generation...\n");

    // Parse arguments
    const { issue, page } = parseArgs();

    // Set up paths
    const COMIC_DIR = join(PROJECT_ROOT, "assets", "comics", "tmnt-mmpr-iii");
    const ISSUE_DIR = join(COMIC_DIR, issue);
    const CACHE_FILE = join(ISSUE_DIR, "bubbles.json");
    const CASTLIST_FILE = join(COMIC_DIR, "castlist.json");
    const AUDIO_DIR = join(ISSUE_DIR, "audio");
    const NO_MATCH_FILE = join(ISSUE_DIR, "no-match-characters.json");
    const TIMESTAMPS_FILE = join(ISSUE_DIR, "audio-timestamps.json");

    console.log(`📁 Issue: ${issue}`);
    console.log(`📖 Cache: ${CACHE_FILE}`);
    console.log(`🎭 Castlist: ${CASTLIST_FILE}`);
    console.log(`💾 Audio output: ${AUDIO_DIR}`);
    console.log(`⏱️  Timestamps: ${TIMESTAMPS_FILE}\n`);

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
      console.error(`   Cache file: ${CACHE_FILE}`);
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
      console.error(`   Castlist file: ${CASTLIST_FILE}`);
      process.exit(1);
    }

    // Verify Narrator exists
    if (!castList["Narrator"]) {
      console.error("❌ Narrator voice not found in castlist!");
      process.exit(1);
    }

    // Ensure audio directory exists
    await fs.ensureDir(AUDIO_DIR);

    // Track statistics
    const noMatches: NoMatchEntry[] = [];
    const timestamps: TimestampsMap = {};
    let totalBubbles = 0;
    let processed = 0;
    let skipped = 0;
    let errors = 0;

    // Process each page
    let pages = Object.keys(cache).sort();

    // Filter to specific page if --page flag is provided
    if (page) {
      const pageKey = `page-${page}.jpg`;
      if (!pages.includes(pageKey)) {
        console.error(`❌ Page ${pageKey} not found in context cache`);
        console.error(`   Available pages: ${pages.join(", ")}`);
        process.exit(1);
      }
      pages = [pageKey];
      console.log(`🎯 Processing single page: ${pageKey}\n`);
    } else {
      console.log(`📄 Processing ${pages.length} pages...\n`);
    }

    for (const pageName of pages) {
      const bubbles = cache[pageName]!;
      console.log(`📄 ${pageName} (${bubbles.length} bubbles)`);

      for (const bubble of bubbles) {
        totalBubbles++;

        // Skip ignored bubbles
        if (bubble.ignored) {
          skipped++;
          continue;
        }

        // Skip if no text
        let textToUse = bubble.textWithCues || bubble.ocr_text;
        if (!textToUse || textToUse.trim().length === 0) {
          skipped++;
          continue;
        }

        // Convert Gemini cues to ElevenLabs-compatible audio tags
        // This removes invalid cues and maps common patterns to valid tags
        if (bubble.textWithCues) {
          textToUse = convertCuesToElevenLabsTags(bubble.textWithCues);
        }

        // Get voice ID
        const { voiceId, matchedName, isFuzzy } = getVoiceId(
          bubble.speaker,
          castList,
        );

        // Track no matches (when we had to use Narrator but speaker was not null)
        if (
          bubble.speaker &&
          matchedName === "Narrator" &&
          !isFuzzy &&
          getCanonicalName(bubble.speaker) !== "Narrator"
        ) {
          noMatches.push({
            characterName: bubble.speaker,
            normalizedName: getCanonicalName(bubble.speaker),
            bubbleId: bubble.id,
            pageName,
          });
        }

        // Generate audio
        try {
          console.log(
            `   [${processed + 1}/${totalBubbles - skipped}] ${bubble.id} - ${matchedName}${isFuzzy ? " (fuzzy)" : ""}`,
          );

          // Map emotion to voice settings for overall tone
          // Lower stability = more expressive/emotional
          // Higher style = more expressive
          const voiceSettings = getVoiceSettingsFromEmotion(bubble.emotion);

          // Use text-to-speech endpoint with timestamps
          const response = await client.textToSpeech.convertWithTimestamps(
            voiceId,
            {
              modelId: "eleven_v3",
              // previousText: '',
              // nextText: '',
              text: textToUse,
              voiceSettings: voiceSettings,
            },
          );

          // Decode base64 audio
          const audioBuffer = Buffer.from(response.audioBase64, "base64");

          // Save audio file
          const audioFileName = `${bubble.id}.mp3`;
          const audioFilePath = join(AUDIO_DIR, audioFileName);
          await fs.writeFile(audioFilePath, audioBuffer);

          // Save timestamps
          // The SDK converts snake_case to camelCase, so we need to check both
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

          // Wait 500ms between API calls to prevent rate limiting
          // Skip delay on last bubble of last page
          if (
            processed < totalBubbles - skipped ||
            pages.indexOf(pageName) < pages.length - 1
          ) {
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
    console.log("⏱️  Saving audio timestamps...");
    await fs.writeFile(TIMESTAMPS_FILE, JSON.stringify(timestamps, null, 2));
    console.log(
      `   ✓ Saved timestamps for ${Object.keys(timestamps).length} bubbles to ${TIMESTAMPS_FILE}\n`,
    );

    // Save no-match characters
    if (noMatches.length > 0) {
      console.log("⚠️  Saving no-match characters...");
      await fs.writeFile(NO_MATCH_FILE, JSON.stringify(noMatches, null, 2));
      console.log(
        `   ✓ Saved ${noMatches.length} entries to ${NO_MATCH_FILE}\n`,
      );
    } else {
      console.log("✅ All characters matched successfully!\n");
    }

    // Summary
    console.log("📊 Summary:");
    console.log(`   Total bubbles: ${totalBubbles}`);
    console.log(`   Processed: ${processed}`);
    console.log(`   Skipped: ${skipped}`);
    console.log(`   Errors: ${errors}`);
    console.log(`   No matches: ${noMatches.length}`);
    console.log("\n✅ Audio generation complete!");
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

main();

#!/usr/bin/env node

/**
 * Generate character voice descriptions from context-cache.json
 *
 * Reads all voice descriptions for each character and uses Gemini 2.5 Flash
 * to generate a single consolidated voice description for Eleven Labs.
 */

import fs from "fs-extra";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI, createPartFromText } from "@google/genai";
import { env } from "~/env.mjs";
import type { Bubble } from "./utils/gemini-context.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

// Get issue number from command line argument or default to issue-1
const ISSUE = process.argv[2] || "issue-1";
const ISSUE_DIR = join(
  PROJECT_ROOT,
  "assets",
  "comics",
  "tmnt-mmpr-iii",
  ISSUE,
);
const CACHE_FILE = join(ISSUE_DIR, "context-cache.json");
const OUTPUT_FILE = join(ISSUE_DIR, "character-voice-descriptions.json");

// Path to reference file (existing character voice descriptions)
// Defaults to issue-1, but can be overridden via command line argument
const REFERENCE_ISSUE = process.argv[3] || "issue-1";
const REFERENCE_FILE = join(
  PROJECT_ROOT,
  "assets",
  "comics",
  "tmnt-mmpr-iii",
  REFERENCE_ISSUE,
  "character-voice-descriptions.json",
);

type ContextCache = Record<string, Bubble[]>;
type CharacterVoiceMap = Record<string, string>;

/**
 * Collect all voice descriptions for each character
 */
function collectCharacterVoiceDescriptions(
  cache: ContextCache,
): Map<string, string[]> {
  const characterVoices = new Map<string, string[]>();

  for (const bubbles of Object.values(cache)) {
    for (const bubble of bubbles) {
      // Only process bubbles with a speaker and a voice description
      if (bubble.speaker && bubble.voiceDescription) {
        const speaker = bubble.speaker;
        if (!characterVoices.has(speaker)) {
          characterVoices.set(speaker, []);
        }
        characterVoices.get(speaker)!.push(bubble.voiceDescription);
      }
    }
  }

  return characterVoices;
}

/**
 * Generate a single voice description for a character using Gemini
 */
async function generateCharacterVoiceDescription(
  gemini: GoogleGenAI,
  characterName: string,
  voiceDescriptions: string[],
): Promise<string> {
  const descriptionsList = voiceDescriptions
    .map((desc, idx) => `${idx + 1}. ${desc}`)
    .join("\n");

  const prompt = `You are generating a voice description for the character "${characterName}" from the Teenage Mutant Ninja Turtles x Mighty Morphin Power Rangers crossover comic book.

Below is a list of context-aware voice descriptions from different pages where this character appears:

${descriptionsList}

Your task is to analyze all these voice descriptions and create a single, comprehensive voice description that captures the essence of this character's voice. This description will be used to generate a voice model via Eleven Labs.

Consider:
- The consistent characteristics across all descriptions
- The character's personality and role in the story
- The tone, pitch, and style that best represents them
- Any unique vocal qualities mentioned

Return ONLY a single, concise voice description (2-3 sentences maximum) that can be used for voice generation. Do not include any explanatory text, just the voice description itself.`;

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
    if (cleanedText.includes("```")) {
      const codeBlockMatch = cleanedText.match(/```[^\n]*\n([\s\S]*?)\n```/);
      if (codeBlockMatch) {
        cleanedText = codeBlockMatch[1]?.trim() ?? cleanedText;
      }
    }

    return cleanedText;
  } catch (error) {
    console.error(
      `Error generating voice description for ${characterName}:`,
      error,
    );
    throw error;
  }
}

/**
 * Load existing character voice descriptions from reference file
 */
async function loadExistingDescriptions(): Promise<CharacterVoiceMap> {
  try {
    if (await fs.pathExists(REFERENCE_FILE)) {
      const existing = await fs.readFile(REFERENCE_FILE, "utf-8");
      const parsed = JSON.parse(existing) as CharacterVoiceMap;
      console.log(
        `   ✓ Loaded ${Object.keys(parsed).length} existing character descriptions from ${REFERENCE_FILE}\n`,
      );
      return parsed;
    } else {
      console.log(
        `   ℹ️  No reference file found at ${REFERENCE_FILE}, will generate all descriptions\n`,
      );
      return {};
    }
  } catch (error) {
    console.warn(
      `   ⚠️  Failed to load reference file: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.log(`   ℹ️  Continuing without reference file...\n`);
    return {};
  }
}

/**
 * Main execution
 */
async function main() {
  try {
    console.log("🎤 Starting character voice description generation...\n");
    console.log(`📁 Processing issue: ${ISSUE}`);
    if (REFERENCE_ISSUE !== ISSUE) {
      console.log(`📚 Using reference from: ${REFERENCE_ISSUE}\n`);
    } else {
      console.log();
    }

    // Load existing descriptions from reference file
    console.log("📖 Loading existing character voice descriptions...");
    const existingDescriptions = await loadExistingDescriptions();

    // Initialize Gemini with GEMINI_API_KEY_2
    const gemini = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY_2 });

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
      console.error(`❌ Failed to load cache: ${error}`);
      process.exit(1);
    }

    // Collect voice descriptions by character
    console.log("🔍 Collecting voice descriptions by character...");
    const characterVoices = collectCharacterVoiceDescriptions(cache);
    console.log(
      `   ✓ Found ${characterVoices.size} unique characters with voice descriptions\n`,
    );

    if (characterVoices.size === 0) {
      console.log("⚠️  No characters with voice descriptions found!");
      return;
    }

    // Display character statistics
    console.log("📊 Character voice description counts:");
    for (const [character, descriptions] of characterVoices.entries()) {
      console.log(`   - ${character}: ${descriptions.length} descriptions`);
    }
    console.log();

    // Start with existing descriptions
    const voiceMap: CharacterVoiceMap = { ...existingDescriptions };

    // Identify characters that need new descriptions
    const characters = Array.from(characterVoices.keys()).sort();
    const charactersToGenerate = characters.filter((char) => !voiceMap[char]);
    const charactersToSkip = characters.filter((char) => voiceMap[char]);

    // Display what will be skipped
    if (charactersToSkip.length > 0) {
      console.log(
        `⏭️  Skipping ${charactersToSkip.length} characters with existing descriptions:`,
      );
      for (const char of charactersToSkip) {
        console.log(`   - ${char}`);
      }
      console.log();
    }

    // Generate consolidated voice descriptions for new characters
    let processed = 0;
    let errors = 0;

    if (charactersToGenerate.length > 0) {
      console.log(
        `🤖 Generating consolidated voice descriptions for ${charactersToGenerate.length} new characters...\n`,
      );

      for (const characterName of charactersToGenerate) {
        const descriptions = characterVoices.get(characterName)!;
        console.log(
          `   [${processed + 1}/${charactersToGenerate.length}] Processing ${characterName}...`,
        );

        try {
          const consolidatedDescription =
            await generateCharacterVoiceDescription(
              gemini,
              characterName,
              descriptions,
            );
          voiceMap[characterName] = consolidatedDescription;
          console.log(`      ✓ Generated voice description`);
          processed++;

          // Wait 2 seconds between API calls to prevent rate limiting
          // Skip delay on last character
          if (processed < charactersToGenerate.length) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        } catch (error) {
          console.error(
            `      ❌ Error: ${error instanceof Error ? error.message : String(error)}`,
          );
          errors++;
        }
      }

      console.log();
    } else {
      console.log(
        "✅ All characters already have descriptions, nothing to generate!\n",
      );
    }

    // Save output
    console.log("\n💾 Saving character voice descriptions...");
    await fs.writeFile(OUTPUT_FILE, JSON.stringify(voiceMap, null, 2));
    console.log(`   ✓ Saved to ${OUTPUT_FILE}\n`);

    // Summary
    console.log("📊 Summary:");
    console.log(`   Total characters: ${characters.length}`);
    console.log(`   Existing (reused): ${charactersToSkip.length}`);
    if (charactersToGenerate.length > 0) {
      console.log(`   Newly generated: ${processed}`);
      if (errors > 0) {
        console.log(`   Errors: ${errors}`);
      }
    }
    console.log("\n✅ Character voice description generation complete!");
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

main();

#!/usr/bin/env node

/**
 * Generate character voice descriptions from bubbles.json
 *
 * Reads all voice descriptions for each character and uses Gemini 2.5 Flash
 * to generate a single consolidated voice description for Eleven Labs.
 */

import fs from "fs-extra";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI, createPartFromText } from "@google/genai";
import { GEMINI_MEDIUM } from "./utils/models.js";
import { env } from "~/env.mjs";
import type { Bubble } from "./utils/gemini-context.js";
import { loadBookConfig } from "./utils/roster.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

function parseArgs(): { book: string; issue: string; referenceIssue: string } {
  const args = process.argv.slice(2);
  let book = process.env.COMIC_BOOK ?? "tmnt-mmpr-iii";
  let issue = process.env.COMIC_ISSUE ?? "issue-1";
  let referenceIssue = issue;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg.startsWith("--book=")) {
      book = arg.split("=")[1]?.trim() ?? book;
    }
    if (arg === "--book") {
      const next = args[i + 1];
      if (next) book = next.trim();
    }
    if (arg.startsWith("--issue=")) {
      const issueNum = arg.split("=")[1]?.trim();
      if (issueNum)
        issue = issueNum.startsWith("issue-") ? issueNum : `issue-${issueNum}`;
    }
    if (arg === "--issue") {
      const next = args[i + 1];
      if (next) {
        issue = next.startsWith("issue-") ? next : `issue-${next}`;
      }
    }
    if (arg.startsWith("--reference-issue=")) {
      const ref = arg.split("=")[1]?.trim();
      if (ref) referenceIssue = ref.startsWith("issue-") ? ref : `issue-${ref}`;
    }
    if (arg === "--reference-issue") {
      const next = args[i + 1];
      if (next)
        referenceIssue = next.startsWith("issue-") ? next : `issue-${next}`;
    }
  }

  // default referenceIssue to issue if not overridden
  if (!args.some((a) => a.startsWith("--reference-issue"))) {
    referenceIssue = issue;
  }

  return { book, issue, referenceIssue };
}

type ContextCache = Record<string, Bubble[]>;
export type CharacterVoiceEntry = { description: string; named: boolean };
type CharacterVoiceMap = Record<string, CharacterVoiceEntry>;
type LegacyOrNewEntry = string | CharacterVoiceEntry;

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
 * Generate a consolidated voice description + named classification for a character using Gemini
 */
async function generateCharacterVoiceDescription(
  gemini: GoogleGenAI,
  characterName: string,
  voiceDescriptions: string[],
  bookTitle: string,
  characterContextInstruction: string,
): Promise<CharacterVoiceEntry> {
  const descriptionsList = voiceDescriptions
    .map((desc, idx) => `${idx + 1}. ${desc}`)
    .join("\n");

  const contextLine = characterContextInstruction
    ? `\nFranchise context: ${characterContextInstruction}\n`
    : "";

  const prompt = `You are generating a voice description for the character "${characterName}" from ${bookTitle}.
${contextLine}
Below is a list of context-aware voice descriptions from different pages where this character appears:

${descriptionsList}

Your task is to:
1. Create a single, comprehensive voice description that captures the essence of this character's voice for AI voice generation.
2. Classify whether this character is "named" (has a specific proper name from the source franchise, e.g. Goldar, Baxter Stockman, Bulk, Lord Zedd) or "generic" (described only by role or appearance, e.g. "Female Soldier", "Unknown Voice", "Robo-Foot Soldier", "Winged Monster").

Consider:
- The consistent characteristics across all descriptions
- The character's personality and role in the story
- The tone, pitch, and style that best represents them
- Any unique vocal qualities mentioned

Return ONLY a JSON object (no markdown, no extra text) with this exact structure:
{
  "description": "..voice description (2-3 sentences)..",
  "named": true
}`;

  try {
    const textPart = createPartFromText(prompt);

    const response = await gemini.models.generateContent({
      model: GEMINI_MEDIUM,
      contents: [textPart],
    });

    const text = response.text;
    if (!text) {
      throw new Error("No text response from Gemini");
    }

    let jsonText = text.trim();
    const codeBlockMatch = jsonText.match(/```(?:json)?\n?([\s\S]*?)\n?```/);
    if (codeBlockMatch) {
      jsonText = codeBlockMatch[1]?.trim() ?? jsonText;
    }
    const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
    if (jsonMatch) jsonText = jsonMatch[0]!;

    const parsed = JSON.parse(jsonText) as {
      description?: string;
      named?: boolean;
    };
    return {
      description: parsed.description ?? text.trim(),
      named: parsed.named ?? true,
    };
  } catch (error) {
    console.error(
      `Error generating voice description for ${characterName}:`,
      error,
    );
    throw error;
  }
}

/**
 * Load existing character voice descriptions from reference file (handles legacy string format)
 */
async function loadExistingDescriptions(
  referenceFile: string,
): Promise<CharacterVoiceMap> {
  try {
    if (await fs.pathExists(referenceFile)) {
      const existing = await fs.readFile(referenceFile, "utf-8");
      const raw = JSON.parse(existing) as Record<string, LegacyOrNewEntry>;
      const normalized: CharacterVoiceMap = {};
      for (const [name, value] of Object.entries(raw)) {
        normalized[name] =
          typeof value === "string"
            ? { description: value, named: true }
            : value;
      }
      console.log(
        `   ✓ Loaded ${Object.keys(normalized).length} existing character descriptions from ${referenceFile}\n`,
      );
      return normalized;
    } else {
      console.log(
        `   ℹ️  No reference file found at ${referenceFile}, will generate all descriptions\n`,
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
    const { book, issue, referenceIssue } = parseArgs();

    const ISSUE_DIR = join(PROJECT_ROOT, "assets", "comics", book, issue);
    const BOOK_DIR = join(PROJECT_ROOT, "assets", "comics", book);
    const CACHE_FILE = join(ISSUE_DIR, "bubbles.json");
    const OUTPUT_FILE = join(ISSUE_DIR, "character-voice-descriptions.json");
    const REFERENCE_FILE = join(
      PROJECT_ROOT,
      "assets",
      "comics",
      book,
      referenceIssue,
      "character-voice-descriptions.json",
    );

    const bookConfig = await loadBookConfig(BOOK_DIR);
    const bookTitle =
      bookConfig?.title ??
      "Teenage Mutant Ninja Turtles x Mighty Morphin Power Rangers crossover comic book";
    const characterContextInstruction = bookConfig?.characterContext ?? "";

    console.log("🎤 Starting character voice description generation...\n");
    console.log(`📁 Processing issue: ${issue}`);
    if (referenceIssue !== issue) {
      console.log(`📚 Using reference from: ${referenceIssue}\n`);
    } else {
      console.log();
    }

    // Load existing descriptions from reference file
    console.log("📖 Loading existing character voice descriptions...");
    const existingDescriptions = await loadExistingDescriptions(REFERENCE_FILE);

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
              bookTitle,
              characterContextInstruction,
            );
          voiceMap[characterName] = consolidatedDescription;
          const namedLabel = consolidatedDescription.named
            ? "named"
            : "generic";
          console.log(`      ✓ Generated voice description (${namedLabel})`);
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

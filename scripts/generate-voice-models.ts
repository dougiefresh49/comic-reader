#!/usr/bin/env node

/**
 * Generate voice models for characters using ElevenLabs API
 *
 * Reads source-material.json and creates voice models via:
 * 1. POST /v1/text-to-voice/design (design the voice)
 * 2. POST /v1/text-to-voice (create the voice from preview)
 *
 * Outputs castlist.json with { characterName: voiceId }
 */

import fs from "fs-extra";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { env } from "~/env.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

const ELEVENLABS_API_BASE = "https://api.elevenlabs.io";

type CharacterVoiceMap = Record<string, string>;
type CastList = Record<string, string>;

interface VoiceDesignRequest {
  voice_description: string;
  model_id?: "eleven_multilingual_ttv_v2" | "eleven_ttv_v3";
  text?: string | null;
  auto_generate_text?: boolean;
}

interface VoicePreview {
  audio_base_64: string;
  generated_voice_id: string;
  media_type: string;
  duration_secs: number;
  language: string | null;
}

interface VoiceDesignResponse {
  previews: VoicePreview[];
  text: string;
}

interface VoiceCreateRequest {
  voice_name: string;
  voice_description: string;
  generated_voice_id: string;
  labels?: Record<string, string> | null;
  played_not_selected_voice_ids?: string[] | null;
}

interface VoiceCreateResponse {
  voice_id: string;
  [key: string]: unknown;
}

/**
 * Parse command-line arguments
 */
function parseArgs(): { issue: string } {
  const args = process.argv.slice(2);

  // Check for help flag
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage: npm run generate-voice-models [options]

Options:
  --issue=N, --issue N        Issue number (e.g., --issue=1 for issue-1, default: issue-1)
  --help, -h                  Show this help message

Examples:
  npm run generate-voice-models                    Generate voices for issue-1
  npm run generate-voice-models --issue=2         Generate voices for issue-2
`);
    process.exit(0);
  }

  let issue = "issue-1";

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
  }

  return { issue };
}

/**
 * Design a voice using ElevenLabs API
 */
async function designVoice(
  apiKey: string,
  voiceDescription: string,
): Promise<VoicePreview> {
  const url = `${ELEVENLABS_API_BASE}/v1/text-to-voice/design`;
  const body: VoiceDesignRequest = {
    voice_description: voiceDescription,
    model_id: "eleven_ttv_v3",
    auto_generate_text: true,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to design voice: ${response.status} ${response.statusText} - ${errorText}`,
    );
  }

  const data = (await response.json()) as VoiceDesignResponse;

  if (!data.previews || data.previews.length === 0) {
    throw new Error("No voice previews returned from design API");
  }

  // Return the first preview (user can manually select if needed)
  return data.previews[0]!;
}

/**
 * Create a voice from a generated preview
 */
async function createVoice(
  apiKey: string,
  characterName: string,
  voiceDescription: string,
  generatedVoiceId: string,
): Promise<string> {
  const url = `${ELEVENLABS_API_BASE}/v1/text-to-voice`;
  const body: VoiceCreateRequest = {
    voice_name: characterName,
    voice_description: voiceDescription,
    generated_voice_id: generatedVoiceId,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to create voice: ${response.status} ${response.statusText} - ${errorText}`,
    );
  }

  const data = (await response.json()) as VoiceCreateResponse;

  if (!data.voice_id) {
    throw new Error("No voice_id returned from create API");
  }

  return data.voice_id;
}

/**
 * Main execution
 */
async function main() {
  try {
    console.log("🎤 Starting voice model generation...\n");

    // Parse arguments
    const { issue } = parseArgs();

    // Set up paths
    const COMIC_DIR = join(PROJECT_ROOT, "assets", "comics", "tmnt-mmpr-iii");
    const ISSUE_DIR = join(COMIC_DIR, issue);
    const INPUT_FILE = join(COMIC_DIR, "source-material.json");
    const OUTPUT_FILE = join(ISSUE_DIR, "castlist.json");

    console.log(`📁 Issue: ${issue}`);
    console.log(`📖 Input: ${INPUT_FILE}`);
    console.log(`💾 Output: ${OUTPUT_FILE}\n`);

    // Check API key
    const apiKey = env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      console.error("❌ ELEVENLABS_API_KEY not found in environment variables");
      process.exit(1);
    }

    // Load source material
    console.log("📖 Loading source material...");
    let voiceDescriptions: CharacterVoiceMap = {};
    try {
      const existing = await fs.readFile(INPUT_FILE, "utf-8");
      voiceDescriptions = JSON.parse(existing) as CharacterVoiceMap;
      console.log(
        `   ✓ Loaded ${Object.keys(voiceDescriptions).length} characters\n`,
      );
    } catch (error) {
      console.error(`❌ Failed to load source material: ${error}`);
      console.error(`   Input file: ${INPUT_FILE}`);
      process.exit(1);
    }

    if (Object.keys(voiceDescriptions).length === 0) {
      console.log("⚠️  No character voice descriptions found!");
      return;
    }

    // Validate structure
    console.log("🔍 Validating source material structure...");
    const invalidEntries: string[] = [];
    for (const [characterName, description] of Object.entries(
      voiceDescriptions,
    )) {
      if (!characterName || typeof characterName !== "string") {
        invalidEntries.push(`Invalid character name: ${String(characterName)}`);
      }
      if (!description || typeof description !== "string") {
        invalidEntries.push(
          `Invalid description for "${characterName}": ${String(description)}`,
        );
      }
      if (description && description.trim().length === 0) {
        invalidEntries.push(`Empty description for "${characterName}"`);
      }
    }

    if (invalidEntries.length > 0) {
      console.error("❌ Validation errors found:");
      for (const error of invalidEntries) {
        console.error(`   - ${error}`);
      }
      process.exit(1);
    }
    console.log("   ✓ All entries are valid\n");

    // Display characters with preview
    console.log("📋 Characters to process:");
    const characters = Object.keys(voiceDescriptions).sort();
    for (const characterName of characters) {
      const description = voiceDescriptions[characterName]!;
      const preview =
        description.length > 80
          ? `${description.slice(0, 80)}...`
          : description;
      console.log(`   - ${characterName}`);
      console.log(`     "${preview}"`);
    }
    console.log();

    // Generate voice models
    console.log("🎙️  Generating voice models...\n");
    const castList: CastList = {};
    let processed = 0;
    let errors = 0;

    for (const characterName of characters) {
      const voiceDescription = voiceDescriptions[characterName]!;
      console.log(
        `   [${processed + 1}/${characters.length}] Processing ${characterName}...`,
      );

      try {
        // Step 1: Design the voice
        console.log(`      🎨 Designing voice...`);
        const preview = await designVoice(apiKey, voiceDescription);
        console.log(
          `         ✓ Generated preview (ID: ${preview.generated_voice_id})`,
        );

        // Step 2: Create the voice
        console.log(`      🎭 Creating voice model...`);
        const voiceId = await createVoice(
          apiKey,
          characterName,
          voiceDescription,
          preview.generated_voice_id,
        );
        castList[characterName] = voiceId;
        console.log(`         ✓ Created voice (ID: ${voiceId})`);

        processed++;

        // Wait 2 seconds between API calls to prevent rate limiting
        // Skip delay on last character
        if (processed < characters.length) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      } catch (error) {
        console.error(
          `      ❌ Error: ${error instanceof Error ? error.message : String(error)}`,
        );
        errors++;
      }
    }

    // Save output
    console.log("\n💾 Saving cast list...");
    await fs.writeFile(OUTPUT_FILE, JSON.stringify(castList, null, 2));
    console.log(`   ✓ Saved to ${OUTPUT_FILE}\n`);

    // Summary
    console.log("📊 Summary:");
    console.log(`   Processed: ${processed}`);
    console.log(`   Errors: ${errors}`);
    console.log(`   Total characters: ${characters.length}`);
    console.log("\n✅ Voice model generation complete!");
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

main();

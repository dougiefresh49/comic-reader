#!/usr/bin/env node

/**
 * Generate voice models for new characters using ElevenLabs API.
 *
 * Reads new-characters.json (character → voice description) and creates
 * voice_design voices for characters whose registry appearance has
 * mediaType "voice_design" and no voice yet.
 *
 * After creating voices, writes back to the registry, generates
 * cast-selections.json, and derives castlist.json for generate-audio.
 */

import fs from "fs-extra";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { env } from "~/env.mjs";
import {
  loadRegistry,
  saveRegistry,
  loadCastSelections,
  saveCastSelections,
} from "./utils/registry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

const ELEVENLABS_API_BASE = "https://api.elevenlabs.io";

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

function parseArgs(): { book: string; issue: string } {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage: pnpm generate-voice-models -- --book <name> --issue <n>

Options:
  --book=NAME, --book NAME     Book name
  --issue=N, --issue N         Issue number
  --help, -h                   Show this help message
`);
    process.exit(0);
  }

  let book = process.env.COMIC_BOOK ?? "tmnt-mmpr-iii";
  let issue = process.env.COMIC_ISSUE ?? "issue-1";

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
  }

  return { book, issue };
}

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

  return data.previews[0]!;
}

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

async function main() {
  try {
    console.log("🎤 Starting voice model generation...\n");

    const { book, issue } = parseArgs();

    const ISSUE_DIR = join(PROJECT_ROOT, "assets", "comics", book, issue);
    const NEW_CHARS_FILE = join(ISSUE_DIR, "new-characters.json");
    const CASTLIST_FILE = join(ISSUE_DIR, "castlist.json");

    console.log(`📁 Issue: ${book}/${issue}`);
    console.log(`📖 Input: ${NEW_CHARS_FILE}`);
    console.log(`💾 Output: ${CASTLIST_FILE}\n`);

    const apiKey = env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      console.error("❌ ELEVENLABS_API_KEY not found");
      process.exit(1);
    }

    // Load new-characters.json (character → voice description)
    if (!(await fs.pathExists(NEW_CHARS_FILE))) {
      console.error(`❌ Not found: ${NEW_CHARS_FILE}`);
      console.error(
        `   Run clean-voice-descriptions and find-voice-sources first.`,
      );
      process.exit(1);
    }

    const newChars = (await fs.readJson(NEW_CHARS_FILE)) as Record<
      string,
      string
    >;
    const characterNames = Object.keys(newChars).sort();

    if (characterNames.length === 0) {
      console.log("ℹ️  No new characters — skipping voice creation.");
    } else {
      console.log(`📋 ${characterNames.length} new character(s) to process\n`);
    }

    const registry = await loadRegistry();
    let processed = 0;
    let skipped = 0;
    let errors = 0;

    // Process new characters
    for (const characterName of characterNames) {
      const voiceDescription = newChars[characterName]!;
      const entry = registry[characterName];

      // Find a pending voice_design appearance (mediaType === "voice_design", voice === null)
      const pendingDesign = entry?.appearances.find(
        (a) => a.mediaType === "voice_design" && a.voice === null,
      );

      // Find an appearance with needs_model status (IVC clips are ready)
      const pendingIvc = entry?.appearances.find(
        (a) =>
          a.mediaType !== "voice_design" && a.voice?.status === "needs_model",
      );

      if (pendingDesign) {
        console.log(
          `   [${processed + skipped + errors + 1}/${characterNames.length}] ${characterName} (voice_design)`,
        );

        try {
          console.log(`      🎨 Designing voice...`);
          const preview = await designVoice(apiKey, voiceDescription);
          console.log(`         ✓ Preview ID: ${preview.generated_voice_id}`);

          console.log(`      🎭 Creating voice model...`);
          const voiceId = await createVoice(
            apiKey,
            characterName,
            voiceDescription,
            preview.generated_voice_id,
          );
          console.log(`         ✓ Voice ID: ${voiceId}`);

          // Write back to registry
          pendingDesign.voice = {
            voiceId,
            voiceType: "voice_design",
            status: "ready",
            createdAt: new Date().toISOString(),
          };

          processed++;

          if (processed < characterNames.length) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        } catch (error) {
          console.error(
            `      ❌ ${error instanceof Error ? error.message : String(error)}`,
          );
          errors++;
        }
      } else if (pendingIvc) {
        // IVC with clips ready — placeholder for when IVC creation is implemented
        console.log(
          `   [${processed + skipped + errors + 1}/${characterNames.length}] ${characterName} (IVC needs_model — skipping, implement IVC creation separately)`,
        );
        skipped++;
      } else if (entry?.appearances.some((a) => a.voice?.status === "ready")) {
        console.log(
          `   [${processed + skipped + errors + 1}/${characterNames.length}] ${characterName} — already ready, skipping`,
        );
        skipped++;
      } else {
        // No registry entry or appearance not yet selected (needs_clips)
        console.log(
          `   [${processed + skipped + errors + 1}/${characterNames.length}] ${characterName} — no pending voice model (needs_clips or not set up)`,
        );
        skipped++;
      }
    }

    // Save registry with any new voice IDs
    if (processed > 0) {
      await saveRegistry(registry);
      console.log(`\n💾 Registry updated with ${processed} new voice(s)`);
    }

    // Build cast-selections.json: start from known-character selections
    // (written by find-voice-sources) and add newly created new-character voices
    const castSelections = await loadCastSelections(ISSUE_DIR);

    for (const characterName of characterNames) {
      const entry = registry[characterName];
      if (!entry) continue;

      // Find the ready appearance for this character
      const readyApp = entry.appearances.find(
        (a) => a.voice?.status === "ready",
      );
      if (readyApp) {
        castSelections[characterName] = {
          appearanceId: readyApp.id,
          voiceId: readyApp.voice!.voiceId,
        };
      }
    }

    await saveCastSelections(ISSUE_DIR, castSelections);
    console.log(
      `\n💾 cast-selections.json updated (${Object.keys(castSelections).length} total characters)`,
    );

    // Derive castlist.json from cast-selections for generate-audio compatibility
    const castList: CastList = {};
    for (const [character, selection] of Object.entries(castSelections)) {
      castList[character] = selection.voiceId;
    }

    await fs.writeFile(CASTLIST_FILE, JSON.stringify(castList, null, 2));
    console.log(
      `💾 castlist.json derived (${Object.keys(castList).length} characters) → ${CASTLIST_FILE}`,
    );

    console.log("\n📊 Summary:");
    console.log(`   Created: ${processed}`);
    console.log(`   Skipped: ${skipped}`);
    console.log(`   Errors:  ${errors}`);
    console.log("\n✅ Voice model generation complete!");
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

main();

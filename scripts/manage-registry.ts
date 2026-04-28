#!/usr/bin/env node

import fs from "fs-extra";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as readline from "readline";
import { GoogleGenAI, createPartFromText } from "@google/genai";
import { GEMINI_MEDIUM } from "./utils/models.js";
import { env } from "~/env.mjs";
import {
  loadRegistry,
  saveRegistry,
  slugify,
  generateAppearanceId,
  saveCastSelections,
  getReadyAppearances,
} from "./utils/registry.js";
import type {
  CharacterRegistry,
  CharacterRegistryEntry,
  AppearanceEntry,
  MediaType,
  CastSelections,
} from "./types/registry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

const ELEVENLABS_API_BASE = "https://api.elevenlabs.io";

// --- Arg parsing ---

interface Args {
  list: boolean;
  character?: string;
  migrate: boolean;
  book?: string;
  issue?: string;
  refreshAppearances: boolean;
  resetVoice: boolean;
  appearance?: string;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage:
  pnpm manage-registry -- --list
  pnpm manage-registry -- --character "Raphael"
  pnpm manage-registry -- --migrate --book tmnt-mmpr-iii --issue 1
  pnpm manage-registry -- --character "Raphael" --refresh-appearances
  pnpm manage-registry -- --character "Raphael" --appearance "raphael-1990-movie" --reset-voice
`);
    process.exit(0);
  }

  const result: Args = {
    list: args.includes("--list"),
    migrate: args.includes("--migrate"),
    refreshAppearances: args.includes("--refresh-appearances"),
    resetVoice: args.includes("--reset-voice"),
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    if (arg.startsWith("--character=")) {
      result.character = arg.split("=").slice(1).join("=").trim();
    } else if (arg === "--character") {
      result.character = args[i + 1]?.trim();
    }

    if (arg.startsWith("--appearance=")) {
      result.appearance = arg.split("=").slice(1).join("=").trim();
    } else if (arg === "--appearance") {
      result.appearance = args[i + 1]?.trim();
    }

    if (arg.startsWith("--book=")) {
      result.book = arg.split("=")[1]?.trim();
    } else if (arg === "--book") {
      result.book = args[i + 1]?.trim();
    }

    if (arg.startsWith("--issue=")) {
      const val = arg.split("=")[1]?.trim();
      if (val) result.issue = val.startsWith("issue-") ? val : `issue-${val}`;
    } else if (arg === "--issue") {
      const val = args[i + 1]?.trim();
      if (val) result.issue = val.startsWith("issue-") ? val : `issue-${val}`;
    }
  }

  return result;
}

// --- ElevenLabs ---

interface ElevenLabsVoice {
  voice_id: string;
  name: string;
  category: "cloned" | "generated" | "premade" | "professional" | string;
  labels?: Record<string, string>;
}

async function fetchVoiceDetails(
  apiKey: string,
  voiceId: string,
): Promise<ElevenLabsVoice> {
  const response = await fetch(`${ELEVENLABS_API_BASE}/v1/voices/${voiceId}`, {
    headers: { "xi-api-key": apiKey },
  });
  if (!response.ok) {
    throw new Error(`ElevenLabs ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as ElevenLabsVoice;
}

// --- Gemini ---

interface GeminiAppearance {
  mediaTitle: string;
  year: number;
  voiceActor: string;
  mediaType: MediaType;
  youtubeSearchTerms: string[];
  notes: string;
}

async function researchAppearances(
  gemini: GoogleGenAI,
  characterName: string,
  franchise: string,
): Promise<GeminiAppearance[]> {
  const prompt = `What animated series, movies, video games, or live-action productions has the character "${characterName}" from "${franchise}" appeared in with voiced dialogue?

For each appearance, return:
- mediaTitle: name of the show/movie/game
- year: release year
- voiceActor: name of voice actor
- mediaType: "animated_series" | "movie" | "video_game" | "live_action"
- youtubeSearchTerms: 2-3 good search queries to find clips on YouTube
- notes: any relevant context (e.g., "original voice actor", "reboot", "cameo only")

Return as a JSON array only, with no markdown formatting or extra text.`;

  const response = await gemini.models.generateContent({
    model: GEMINI_MEDIUM,
    contents: [createPartFromText(prompt)],
  });

  const text = response.text;
  if (!text) throw new Error("Empty response from Gemini");

  let jsonText = text.trim();
  const match = jsonText.match(/```(?:json)?\n?([\s\S]*?)\n?```/);
  if (match) jsonText = match[1]?.trim() ?? jsonText;

  try {
    return JSON.parse(jsonText) as GeminiAppearance[];
  } catch {
    throw new Error(
      `Could not parse Gemini response: ${jsonText.slice(0, 200)}`,
    );
  }
}

function guessFranchise(characterName: string): string {
  const lower = characterName.toLowerCase();
  const tmnt = [
    "leonardo",
    "donatello",
    "michelangelo",
    "raphael",
    "shredder",
    "splinter",
    "karai",
    "bebop",
    "rocksteady",
    "foot",
  ];
  const pr = [
    "ranger",
    "zordon",
    "alpha 5",
    "alpha5",
    "rita",
    "lord zedd",
    "zedd",
  ];
  if (tmnt.some((n) => lower.includes(n))) return "TMNT";
  if (pr.some((n) => lower.includes(n))) return "Power Rangers";
  return "Unknown";
}

// --- Interactive prompt helpers ---

function createRl(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

async function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function askNumber(
  rl: readline.Interface,
  question: string,
  min: number,
  max: number,
): Promise<number> {
  const prompt = async (): Promise<number> => {
    const answer = await ask(rl, question);
    const n = parseInt(answer.trim(), 10);
    if (!isNaN(n) && n >= min && n <= max) return n;
    console.log(`   Enter a number between ${min} and ${max}`);
    return prompt();
  };
  return prompt();
}

// --- Commands ---

async function cmdList(): Promise<void> {
  const registry = await loadRegistry();
  const chars = Object.entries(registry).sort(([a], [b]) => a.localeCompare(b));

  if (chars.length === 0) {
    console.log(
      "Registry is empty. Run --migrate to populate it from an existing issue.",
    );
    return;
  }

  console.log(
    `\n${"Character".padEnd(24)} ${"Franchise".padEnd(18)} ${"Appearances".padEnd(16)} Status`,
  );
  console.log("─".repeat(74));

  for (const [name, entry] of chars) {
    const total = entry.appearances.length;
    const ready = entry.appearances.filter(
      (a) => a.voice?.status === "ready",
    ).length;
    const status =
      ready === total && total > 0 ? "ready" : ready > 0 ? "partial" : "none";
    const appSummary = total === 0 ? "none" : `${total} (${ready} ready)`;
    console.log(
      `${name.padEnd(24)} ${entry.franchise.padEnd(18)} ${appSummary.padEnd(16)} ${status}`,
    );
  }
  console.log();
}

async function cmdCharacter(name: string): Promise<void> {
  const registry = await loadRegistry();
  const entry = registry[name];

  if (!entry) {
    console.log(`Character "${name}" not found in registry.`);
    return;
  }

  const header = `── ${name} (${entry.franchise}) `;
  console.log(`\n${header}${"─".repeat(Math.max(0, 60 - header.length))}`);
  if (entry.aliases.length > 0) {
    console.log(`   Aliases: ${entry.aliases.join(", ")}`);
  }

  if (entry.appearances.length === 0) {
    console.log("   No appearances.\n");
    return;
  }

  console.log();
  for (const app of entry.appearances) {
    const voiceStr = app.voice
      ? `${app.voice.voiceType} — ${app.voice.status} (${app.voice.voiceId})`
      : "no voice";
    const titleStr = app.mediaTitle
      ? `${app.mediaTitle}${app.year ? ` (${app.year})` : ""}`
      : "Voice Design";
    console.log(`   ${app.id}`);
    console.log(
      `     ${titleStr}${app.voiceActor ? ` — ${app.voiceActor}` : ""}`,
    );
    console.log(`     Voice: ${voiceStr}`);
    if (app.notes) console.log(`     Notes: ${app.notes}`);
    console.log();
  }
}

async function cmdMigrate(book: string, issue: string): Promise<void> {
  const issueDir = join(PROJECT_ROOT, "assets", "comics", book, issue);
  const castlistPath = join(issueDir, "castlist.json");

  if (!(await fs.pathExists(castlistPath))) {
    console.error(`❌ Not found: ${castlistPath}`);
    console.error(`   Copy the book-level castlist first:`);
    console.error(`   cp assets/comics/${book}/castlist.json ${castlistPath}`);
    process.exit(1);
  }

  const castlist = (await fs.readJson(castlistPath)) as Record<string, string>;
  const registry = await loadRegistry();
  const apiKey = env.ELEVENLABS_API_KEY;

  // Load voice descriptions — book-level preferred, issue-level as fallback
  const bookDir = join(PROJECT_ROOT, "assets", "comics", book);
  const bookDescPath = join(bookDir, "character-voice-descriptions.json");
  const issueDescPath = join(issueDir, "character-voice-descriptions.json");
  let voiceDescriptions: Record<string, string> = {};
  if (await fs.pathExists(bookDescPath)) {
    voiceDescriptions = (await fs.readJson(bookDescPath)) as Record<
      string,
      string
    >;
    console.log(`📝 Loaded voice descriptions from book-level file`);
  } else if (await fs.pathExists(issueDescPath)) {
    voiceDescriptions = (await fs.readJson(issueDescPath)) as Record<
      string,
      string
    >;
    console.log(`📝 Loaded voice descriptions from issue-level file`);
  } else {
    console.log(
      `⚠️  No character-voice-descriptions.json found — voiceDescription will be null`,
    );
  }

  const characters = Object.entries(castlist).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  console.log(
    `\n🔄 Migrating ${characters.length} characters — ${book}/${issue}\n`,
  );

  // Build a lookup: voiceId → already-in-registry appearance
  function findExistingAppearance(
    name: string,
    voiceId: string,
  ): AppearanceEntry | undefined {
    return registry[name]?.appearances.find(
      (a) => a.voice?.voiceId === voiceId,
    );
  }

  // Step 1: Fetch voice details for characters not already in registry
  console.log("Step 1 — Fetching voice details from ElevenLabs...\n");

  const voiceDetails = new Map<string, ElevenLabsVoice>();

  for (const [name, voiceId] of characters) {
    if (findExistingAppearance(name, voiceId)) {
      console.log(`   ✓ ${name} — already in registry`);
      continue;
    }
    process.stdout.write(`   ${name}... `);
    try {
      const details = await fetchVoiceDetails(apiKey, voiceId);
      voiceDetails.set(name, details);
      console.log(details.category);
    } catch (err) {
      console.log(`❌ ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  // Step 2: Auto-handle Voice Design (category === "generated")
  console.log("\nStep 2 — Processing Voice Design characters...\n");

  const ivcQueue: Array<[string, string]> = [];

  for (const [name, voiceId] of characters) {
    if (findExistingAppearance(name, voiceId)) continue;

    const details = voiceDetails.get(name);
    if (!details) continue;

    if (details.category === "generated") {
      const franchise = guessFranchise(name);
      const appearanceId = `${slugify(name)}-voice-design`;

      if (!registry[name]) {
        registry[name] = { franchise, aliases: [], appearances: [] };
      }

      const alreadyHasDesign = registry[name]!.appearances.some(
        (a) => a.id === appearanceId,
      );
      if (!alreadyHasDesign) {
        registry[name]!.appearances.push({
          id: appearanceId,
          mediaTitle: null,
          year: null,
          voiceActor: null,
          mediaType: "voice_design",
          youtubeSearchTerms: [],
          notes: "Auto-generated from voice description. No source media.",
          voice: {
            voiceId,
            voiceType: "voice_design",
            status: "ready",
            createdAt: new Date().toISOString(),
            voiceDescription: voiceDescriptions[name] ?? null,
          },
        });
      }
      console.log(`   ✅ ${name} → voice_design (auto)`);
    } else if (details.category === "cloned") {
      ivcQueue.push([name, voiceId]);
    } else {
      // premade, professional, or other — treat as opaque voice_design entry
      const franchise = guessFranchise(name);
      const appearanceId = `${slugify(name)}-voice-design`;
      if (!registry[name]) {
        registry[name] = { franchise, aliases: [], appearances: [] };
      }
      if (!registry[name]!.appearances.some((a) => a.id === appearanceId)) {
        registry[name]!.appearances.push({
          id: appearanceId,
          mediaTitle: null,
          year: null,
          voiceActor: null,
          mediaType: "voice_design",
          youtubeSearchTerms: [],
          notes: `ElevenLabs category: ${details.category}`,
          voice: {
            voiceId,
            voiceType: "voice_design",
            status: "ready",
            createdAt: new Date().toISOString(),
            voiceDescription: voiceDescriptions[name] ?? null,
          },
        });
      }
      console.log(`   ✅ ${name} → ${details.category} (auto)`);
    }
  }

  // Step 3: Identify IVC appearances interactively
  if (ivcQueue.length > 0) {
    console.log(
      `\nStep 3 — Identifying source media for ${ivcQueue.length} IVC voice(s)...\n`,
    );
    console.log(
      "─────────────────────────────────────────────────────────────",
    );

    const gemini = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
    const rl = createRl();

    for (const [name, voiceId] of ivcQueue) {
      const franchise = guessFranchise(name);
      const label = `── ${name} (IVC — voice ID: ${voiceId}) `;
      console.log(`\n${label}${"─".repeat(Math.max(0, 64 - label.length))}`);
      process.stdout.write("Fetching media appearances from Gemini...");

      let appearances: GeminiAppearance[] = [];
      try {
        appearances = await researchAppearances(gemini, name, franchise);
        console.log(` ✓ (${appearances.length} found)\n`);
      } catch (err) {
        console.log(
          ` ❌ ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }

      if (!registry[name]) {
        registry[name] = { franchise, aliases: [], appearances: [] };
      }

      let chosenAppearanceId: string;

      if (appearances.length === 0) {
        chosenAppearanceId = `${slugify(name)}-unknown`;
        registry[name]!.appearances.push({
          id: chosenAppearanceId,
          mediaTitle: null,
          year: null,
          voiceActor: null,
          mediaType: "live_action",
          youtubeSearchTerms: [],
          notes: "Source media unknown.",
          voice: {
            voiceId,
            voiceType: "ivc",
            status: "ready",
            createdAt: new Date().toISOString(),
            voiceDescription: voiceDescriptions[name] ?? null,
          },
        });
        console.log(`   ↳ No appearances found — added without source link`);
      } else {
        appearances.forEach((a, i) => {
          const rec = a.notes?.toLowerCase().includes("original")
            ? " ← recommended"
            : "";
          console.log(
            ` ${(i + 1).toString().padStart(2)}. ${`${a.mediaTitle} (${a.year})`.padEnd(42)}${a.voiceActor}${rec}`,
          );
        });
        console.log(` ${appearances.length + 1}. I don't know / skip\n`);

        const choice = await askNumber(
          rl,
          `Which appearance is this voice based on? [1-${appearances.length + 1}]: `,
          1,
          appearances.length + 1,
        );

        if (choice === appearances.length + 1) {
          chosenAppearanceId = `${slugify(name)}-unknown`;
          registry[name]!.appearances.push({
            id: chosenAppearanceId,
            mediaTitle: null,
            year: null,
            voiceActor: null,
            mediaType: "live_action",
            youtubeSearchTerms: [],
            notes: "Source media not identified during migration.",
            voice: {
              voiceId,
              voiceType: "ivc",
              status: "ready",
              createdAt: new Date().toISOString(),
              voiceDescription: voiceDescriptions[name] ?? null,
            },
          });
          console.log(`   ↳ Added without appearance link`);
        } else {
          const selected = appearances[choice - 1]!;
          chosenAppearanceId = generateAppearanceId(name, selected.mediaTitle);
          registry[name]!.appearances.push({
            id: chosenAppearanceId,
            mediaTitle: selected.mediaTitle,
            year: selected.year,
            voiceActor: selected.voiceActor,
            mediaType: selected.mediaType,
            youtubeSearchTerms: selected.youtubeSearchTerms,
            notes: selected.notes,
            voice: {
              voiceId,
              voiceType: "ivc",
              status: "ready",
              createdAt: new Date().toISOString(),
              voiceDescription: voiceDescriptions[name] ?? null,
            },
          });
          console.log(`   ↳ ${selected.mediaTitle} — ${selected.voiceActor}`);
        }
      }

      await new Promise((r) => setTimeout(r, 300));
    }

    rl.close();
  }

  // Save registry before generating cast-selections
  await saveRegistry(registry);
  console.log(
    `\n✅ Registry updated (${Object.keys(registry).length} characters)`,
  );

  // Step 4: Generate cast-selections.json for the migrated issue
  console.log("\nStep 4 — Generating cast-selections.json...\n");

  const castSelections: CastSelections = {};
  const missing: string[] = [];

  for (const [name, voiceId] of characters) {
    const entry = registry[name];
    if (!entry) {
      missing.push(name);
      continue;
    }
    const app = entry.appearances.find((a) => a.voice?.voiceId === voiceId);
    if (app) {
      castSelections[name] = { appearanceId: app.id, voiceId };
    } else {
      missing.push(name);
    }
  }

  if (missing.length > 0) {
    console.log(
      `   ⚠️  Could not find registry entry for: ${missing.join(", ")}`,
    );
  }

  await saveCastSelections(issueDir, castSelections);
  console.log(
    `✅ cast-selections.json written (${Object.keys(castSelections).length} characters) → ${issueDir}/cast-selections.json`,
  );
}

async function cmdRefreshAppearances(name: string): Promise<void> {
  const registry = await loadRegistry();
  const entry = registry[name];

  if (!entry) {
    console.error(`❌ "${name}" not found in registry.`);
    process.exit(1);
  }

  console.log(`\nRefreshing appearances for ${name} (${entry.franchise})...\n`);

  const gemini = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  let appearances: GeminiAppearance[];
  try {
    appearances = await researchAppearances(gemini, name, entry.franchise);
  } catch (err) {
    console.error(
      `❌ Gemini error: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  console.log(
    `Found ${appearances.length} appearances. Merging with existing...\n`,
  );

  // Keep appearances that already have a voice
  const withVoice = entry.appearances.filter((a) => a.voice !== null);
  const existingIds = new Set(withVoice.map((a) => a.id));

  const merged = [...withVoice];
  for (const a of appearances) {
    const id = generateAppearanceId(name, a.mediaTitle);
    if (!existingIds.has(id)) {
      merged.push({
        id,
        mediaTitle: a.mediaTitle,
        year: a.year,
        voiceActor: a.voiceActor,
        mediaType: a.mediaType,
        youtubeSearchTerms: a.youtubeSearchTerms,
        notes: a.notes,
        voice: null,
      });
    }
  }

  registry[name]!.appearances = merged;
  await saveRegistry(registry);
  console.log(`✅ ${name} updated — ${merged.length} total appearances.`);
}

async function cmdResetVoice(
  name: string,
  appearanceId: string,
): Promise<void> {
  const registry = await loadRegistry();
  const entry = registry[name];

  if (!entry) {
    console.error(`❌ "${name}" not found in registry.`);
    process.exit(1);
  }

  const app = entry.appearances.find((a) => a.id === appearanceId);
  if (!app) {
    console.error(`❌ Appearance "${appearanceId}" not found for ${name}.`);
    console.error(
      `   Available: ${entry.appearances.map((a) => a.id).join(", ")}`,
    );
    process.exit(1);
  }

  const oldVoiceId = app.voice?.voiceId ?? "none";
  app.voice = null;
  await saveRegistry(registry);

  console.log(
    `✅ Reset voice for ${name} / ${appearanceId} (was: ${oldVoiceId})`,
  );
  console.log(`   Run ingest to recreate the voice model.`);
}

async function main() {
  const args = parseArgs();

  if (args.list) {
    await cmdList();
    return;
  }

  if (args.migrate) {
    if (!args.book || !args.issue) {
      console.error("❌ --migrate requires --book and --issue");
      process.exit(1);
    }
    await cmdMigrate(args.book, args.issue);
    return;
  }

  if (args.character) {
    if (args.refreshAppearances) {
      await cmdRefreshAppearances(args.character);
      return;
    }
    if (args.resetVoice) {
      if (!args.appearance) {
        console.error("❌ --reset-voice requires --appearance <id>");
        process.exit(1);
      }
      await cmdResetVoice(args.character, args.appearance);
      return;
    }
    await cmdCharacter(args.character);
    return;
  }

  console.log(
    "Usage: pnpm manage-registry -- --list | --character <name> | --migrate --book <name> --issue <n>",
  );
  console.log("Run with --help for full options.");
}

main().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});

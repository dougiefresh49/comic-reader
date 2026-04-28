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
  hasReadyVoice,
  getReadyAppearances,
  getMostRecentReadyAppearance,
  generateAppearanceId,
  saveCastSelections,
  loadCastSelections,
} from "./utils/registry.js";
import type { AppearanceEntry, MediaType } from "./types/registry.js";
import { supabase } from "./lib/supabase.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

interface MediaAppearance {
  mediaTitle: string;
  year: number;
  voiceActor: string;
  mediaType: MediaType;
  youtubeSearchTerms: string[];
  notes: string;
}

function parseArgs(): {
  mode: "character" | "book";
  character?: string;
  franchise?: string;
  book?: string;
  issue?: string;
  db: boolean;
} {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage:
  pnpm find-voice-sources -- --character "Raphael" --franchise "TMNT"
  pnpm find-voice-sources -- --book <name> --issue <n>
  pnpm find-voice-sources -- --book <name> --issue <n> --db   # populate
                                                                # casting_tasks
                                                                # for the
                                                                # browser UI
                                                                # and pause
`);
    process.exit(0);
  }

  let character: string | undefined;
  let franchise: string | undefined;
  let book: string | undefined;
  let issue: string | undefined;
  let db = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    if (arg.startsWith("--character=")) character = arg.split("=")[1]?.trim();
    if (arg === "--character") character = args[i + 1]?.trim();
    if (arg.startsWith("--franchise=")) franchise = arg.split("=")[1]?.trim();
    if (arg === "--franchise") franchise = args[i + 1]?.trim();
    if (arg.startsWith("--book=")) book = arg.split("=")[1]?.trim();
    if (arg === "--book") book = args[i + 1]?.trim();
    if (arg.startsWith("--issue=")) {
      const v = arg.split("=")[1]?.trim();
      if (v) issue = v.startsWith("issue-") ? v : `issue-${v}`;
    }
    if (arg === "--issue") {
      const v = args[i + 1]?.trim();
      if (v) issue = v.startsWith("issue-") ? v : `issue-${v}`;
    }
    if (arg === "--db") db = true;
  }

  if (character) {
    return { mode: "character", character, franchise, db };
  }

  book = book ?? process.env.COMIC_BOOK;
  issue = issue ?? process.env.COMIC_ISSUE;

  if (book && issue) {
    const normalizedIssue = issue.startsWith("issue-")
      ? issue
      : `issue-${issue}`;
    return { mode: "book", book, issue: normalizedIssue, db };
  }

  console.error(
    "❌ Provide either --character + --franchise, or --book + --issue",
  );
  process.exit(1);
}

async function researchCharacter(
  gemini: GoogleGenAI,
  characterName: string,
  franchise: string,
): Promise<MediaAppearance[]> {
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
  const codeBlockMatch = jsonText.match(/```(?:json)?\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    jsonText = codeBlockMatch[1]?.trim() ?? jsonText;
  }

  try {
    return JSON.parse(jsonText) as MediaAppearance[];
  } catch {
    throw new Error(
      `Could not parse Gemini response as JSON: ${jsonText.slice(0, 200)}`,
    );
  }
}

function renderTable(
  characterName: string,
  appearances: MediaAppearance[],
): void {
  const label = `── ${characterName} `;
  const bar = "─".repeat(Math.max(0, 56 - label.length));
  console.log(`\n${label}${bar}`);

  appearances.forEach((a, i) => {
    const recommended = a.notes?.toLowerCase().includes("original")
      ? " ← recommended"
      : "";
    const title = `${i + 1}. ${a.mediaTitle} (${a.year})`;
    console.log(` ${title.padEnd(36)}${a.voiceActor}${recommended}`);
  });
  console.log(` ${appearances.length + 1}. Skip (use auto-generated voice)`);
  console.log();
}

async function promptSelection(
  rl: readline.Interface,
  characterName: string,
  count: number,
): Promise<number> {
  return new Promise((resolve) => {
    const ask = () => {
      rl.question(
        `Pick a voice for ${characterName} [1-${count + 1}]: `,
        (answer) => {
          const n = parseInt(answer.trim(), 10);
          if (!isNaN(n) && n >= 1 && n <= count + 1) {
            resolve(n);
          } else {
            console.log(`   Enter a number between 1 and ${count + 1}`);
            ask();
          }
        },
      );
    };
    ask();
  });
}

// ── Character mode (single-character research, no book context) ──────────────

async function runCharacterMode(
  character: string,
  franchise: string,
): Promise<void> {
  const registry = await loadRegistry();
  const gemini = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

  // Check if already researched
  const existing = registry[character];
  let appearances: MediaAppearance[];

  if (existing && existing.appearances.length > 0) {
    console.log(
      `\n📋 Using cached appearances for ${character} (${existing.appearances.length} found)`,
    );
    appearances = existing.appearances
      .filter((a) => a.mediaTitle)
      .map((a) => ({
        mediaTitle: a.mediaTitle!,
        year: a.year ?? 0,
        voiceActor: a.voiceActor ?? "Unknown",
        mediaType: a.mediaType,
        youtubeSearchTerms: a.youtubeSearchTerms,
        notes: a.notes ?? "",
      }));
  } else {
    console.log(`\n🔍 Researching ${character} (${franchise})...`);
    try {
      appearances = await researchCharacter(gemini, character, franchise);
      console.log(`   Found ${appearances.length} appearance(s)\n`);
    } catch (err) {
      console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // Save appearances to registry (without voice — just cataloging)
    if (!registry[character]) {
      registry[character] = { franchise, aliases: [], appearances: [] };
    }
    for (const a of appearances) {
      const id = generateAppearanceId(character, a.mediaTitle);
      if (!registry[character]!.appearances.some((e) => e.id === id)) {
        registry[character]!.appearances.push({
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
    await saveRegistry(registry);
  }

  renderTable(character, appearances);
  console.log(
    `\n💡 Use --migrate when processing a full issue to link voices to appearances.`,
  );
}

// ── Book mode ─────────────────────────────────────────────────────────────────

type NewCharEntry = string | { description: string; named?: boolean };

function isNamed(entry: NewCharEntry): boolean {
  if (typeof entry === "string") return true;
  return entry.named !== false;
}

async function runBookMode(
  book: string,
  issue: string,
  db = false,
): Promise<void> {
  const issueDir = join(PROJECT_ROOT, "assets", "comics", book, issue);
  const newCharsPath = join(issueDir, "new-characters.json");
  const knownCharsPath = join(issueDir, "known-characters.json");

  if (!(await fs.pathExists(newCharsPath))) {
    console.error(`❌ Not found: ${newCharsPath}`);
    console.error(`   Run clean-voice-descriptions first.`);
    process.exit(1);
  }

  const newChars = (await fs.readJson(newCharsPath)) as Record<
    string,
    NewCharEntry
  >;
  const knownChars: Record<string, NewCharEntry> = (await fs.pathExists(
    knownCharsPath,
  ))
    ? ((await fs.readJson(knownCharsPath)) as Record<string, NewCharEntry>)
    : {};

  const franchise = book
    .split("-")
    .map((w) => w.toUpperCase())
    .join(" ");

  const allNewCharNames = Object.keys(newChars).sort();
  const knownCharNames = Object.keys(knownChars).sort();

  // Split new characters into named (research) and generic (Voice Design directly)
  const namedCharNames = allNewCharNames.filter((c) => isNamed(newChars[c]!));
  const genericCharNames = allNewCharNames.filter(
    (c) => !isNamed(newChars[c]!),
  );
  const newCharNames = namedCharNames;

  console.log(`\n🎙️  Voice Sourcing — ${franchise}`);
  console.log(
    `   ${allNewCharNames.length} new character(s) (${namedCharNames.length} named, ${genericCharNames.length} generic), ${knownCharNames.length} known\n`,
  );

  const registry = await loadRegistry();
  const gemini = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

  // ── Auto-route generic characters directly to Voice Design ───────────────
  if (genericCharNames.length > 0) {
    console.log(
      "─────────────────────────────────────────────────────────────",
    );
    console.log("Routing generic characters to Voice Design (no research):\n");
    for (let i = 0; i < genericCharNames.length; i++) {
      const character = genericCharNames[i]!;
      console.log(
        `   [${i + 1}/${genericCharNames.length}] ${character}... skipped (generic character — Voice Design)`,
      );
      if (!registry[character]) {
        registry[character] = { franchise, aliases: [], appearances: [] };
      }
      const designId = `${character.toLowerCase().replace(/\s+/g, "-")}-voice-design`;
      if (!registry[character]!.appearances.some((a) => a.id === designId)) {
        registry[character]!.appearances.push({
          id: designId,
          mediaTitle: null,
          year: null,
          voiceActor: null,
          mediaType: "voice_design",
          youtubeSearchTerms: [],
          notes: "Generic character — auto-routed to Voice Design.",
          voice: null,
        });
      }
    }
    console.log();
  }

  // ── Research appearances for named characters ─────────────────────────────
  if (newCharNames.length > 0) {
    console.log(
      "─────────────────────────────────────────────────────────────",
    );
    console.log("Researching named characters...\n");

    for (let i = 0; i < newCharNames.length; i++) {
      const character = newCharNames[i]!;
      const cached = registry[character]?.appearances ?? [];

      if (cached.length > 0) {
        console.log(
          `   [${i + 1}/${newCharNames.length}] ${character} — using cached (${cached.length} appearances)`,
        );
        continue;
      }

      process.stdout.write(
        `   [${i + 1}/${newCharNames.length}] Researching ${character}... `,
      );

      try {
        const appearances = await researchCharacter(
          gemini,
          character,
          franchise,
        );
        console.log(`✓ (${appearances.length} appearances)`);

        if (!registry[character]) {
          registry[character] = { franchise, aliases: [], appearances: [] };
        }
        for (const a of appearances) {
          const id = generateAppearanceId(character, a.mediaTitle);
          if (!registry[character]!.appearances.some((e) => e.id === id)) {
            registry[character]!.appearances.push({
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
      } catch (err) {
        console.log(`❌`);
        console.error(
          `      ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (i < newCharNames.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }

    await saveRegistry(registry);
  }

  // ── DB mode: write character_appearances + casting_tasks for the browser ──
  if (db) {
    console.log(
      "\n─────────────────────────────────────────────────────────────",
    );
    console.log("Writing to DB for casting browser UI...\n");

    // Pause issue first so the dashboard reflects state immediately
    await supabase
      .from("issues")
      .update({
        pipeline_step: "find-voice-sources",
        pipeline_paused: true,
        pipeline_paused_at: "find-voice-sources",
        pipeline_paused_url: `/admin/characters/casting?book=${book}&issue=${issue}`,
      })
      .eq("book_id", book)
      .eq("id", issue);

    let charsUpserted = 0;
    let appsUpserted = 0;
    let tasksUpserted = 0;

    for (const character of allNewCharNames) {
      const entry = registry[character];
      if (!entry) continue;

      // 1. characters table — id is the canonical character name
      const { error: cErr } = await supabase.from("characters").upsert(
        {
          id: character,
          franchise: entry.franchise,
          aliases: entry.aliases ?? [],
        },
        { onConflict: "id" },
      );
      if (cErr) {
        console.warn(`   ⚠ characters upsert ${character}: ${cErr.message}`);
        continue;
      }
      charsUpserted++;

      // 2. character_appearances — one row per Gemini-suggested appearance
      for (const app of entry.appearances) {
        const { error: aErr } = await supabase
          .from("character_appearances")
          .upsert(
            {
              id: app.id,
              character_id: character,
              media_title: app.mediaTitle,
              year: app.year,
              voice_actor: app.voiceActor,
              media_type: app.mediaType,
              youtube_search_terms: app.youtubeSearchTerms,
              notes: app.notes,
              voice_id: app.voice?.voiceId ?? null,
              voice_type: app.voice?.voiceType ?? null,
              voice_status: app.voice?.status ?? null,
              voice_description: app.voice?.voiceDescription ?? null,
              voice_created_at: app.voice?.createdAt ?? null,
              voice_model_status:
                app.voice?.status === "ready" ? "ready" : "pending",
            },
            { onConflict: "id" },
          );
        if (aErr) {
          console.warn(`   ⚠ appearance ${app.id}: ${aErr.message}`);
        } else {
          appsUpserted++;
        }
      }

      // 3. casting_tasks — one row per character that doesn't already have a
      //    voice in castlist for this issue. Idempotent: if the row exists
      //    and is already complete/skipped, leave it alone.
      const { data: existingCast } = await supabase
        .from("castlist")
        .select("voice_id")
        .eq("book_id", book)
        .eq("issue_id", issue)
        .eq("character", character)
        .maybeSingle();
      const existingCastVoice = (existingCast as { voice_id?: string } | null)
        ?.voice_id;
      if (existingCastVoice && existingCastVoice !== "__SKIPPED__") {
        // Already cast for this issue — no task needed
        continue;
      }
      const { data: existingTask } = await supabase
        .from("casting_tasks")
        .select("id, status")
        .eq("book_id", book)
        .eq("issue_id", issue)
        .eq("character_id", character)
        .maybeSingle();
      const existing = existingTask as { id: string; status: string } | null;
      if (existing && existing.status !== "pending") {
        // already complete/in_progress/skipped — leave alone
        continue;
      }
      if (!existing) {
        const { error: tErr } = await supabase.from("casting_tasks").insert({
          book_id: book,
          issue_id: issue,
          character_id: character,
          status: "pending",
        });
        if (tErr) {
          console.warn(`   ⚠ casting_task ${character}: ${tErr.message}`);
        } else {
          tasksUpserted++;
        }
      }
    }

    console.log(
      `   ✓ ${charsUpserted} character(s), ${appsUpserted} appearance(s), ${tasksUpserted} casting task(s)\n`,
    );

    // Check whether anything is actually pending — if everything's already
    // cast (e.g. re-running the script after browser completion) advance.
    const { count: pendingCount } = await supabase
      .from("casting_tasks")
      .select("id", { count: "exact", head: true })
      .eq("book_id", book)
      .eq("issue_id", issue)
      .eq("status", "pending");

    if (pendingCount && pendingCount > 0) {
      console.log(`── Casting paused ─────────────────────────────────────`);
      console.log(`  ${pendingCount} character(s) awaiting casting.`);
      console.log(
        `  Open: /admin/characters/casting?book=${book}&issue=${issue}`,
      );
      console.log(`  Run again after completing casting to continue.`);
      console.log(`──────────────────────────────────────────────────────`);
      // Exit 2 = clean pause signal for ingest.ts
      process.exit(2);
    }

    // No pending tasks → clear pause flag and let pipeline continue
    await supabase
      .from("issues")
      .update({
        pipeline_paused: false,
        pipeline_paused_at: null,
        pipeline_paused_url: null,
      })
      .eq("book_id", book)
      .eq("id", issue);
    console.log("✓ All characters already cast — continuing pipeline\n");
    return;
  }

  // Save voice-sourcing-suggestions.json for reference (all new chars)
  const suggestionsPath = join(issueDir, "voice-sourcing-suggestions.json");
  const suggestions: Record<string, MediaAppearance[]> = {};
  for (const character of allNewCharNames) {
    suggestions[character] = (registry[character]?.appearances ?? [])
      .filter((a) => a.mediaTitle)
      .map((a) => ({
        mediaTitle: a.mediaTitle!,
        year: a.year ?? 0,
        voiceActor: a.voiceActor ?? "Unknown",
        mediaType: a.mediaType,
        youtubeSearchTerms: a.youtubeSearchTerms,
        notes: a.notes ?? "",
      }));
  }
  await fs.writeJson(suggestionsPath, suggestions, { spaces: 2 });

  // ── Interactive selection for new characters ──────────────────────────────
  console.log(
    "\n─────────────────────────────────────────────────────────────",
  );
  console.log("Select a voice source for each new character:\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  for (const character of newCharNames) {
    const appearances = (registry[character]?.appearances ?? []).filter(
      (a) => a.mediaTitle,
    );

    if (appearances.length === 0) {
      console.log(
        `\n⚠️  No appearances found for ${character} — will use auto-generated voice`,
      );
      if (!registry[character]) {
        registry[character] = { franchise, aliases: [], appearances: [] };
      }
      registry[character]!.appearances.push({
        id: `${character.toLowerCase().replace(/\s+/g, "-")}-voice-design`,
        mediaTitle: null,
        year: null,
        voiceActor: null,
        mediaType: "voice_design",
        youtubeSearchTerms: [],
        notes: "Auto-generated: no media appearances found.",
        voice: null,
      });
      continue;
    }

    const displayAppearances: MediaAppearance[] = appearances.map((a) => ({
      mediaTitle: a.mediaTitle!,
      year: a.year ?? 0,
      voiceActor: a.voiceActor ?? "Unknown",
      mediaType: a.mediaType,
      youtubeSearchTerms: a.youtubeSearchTerms,
      notes: a.notes ?? "",
    }));

    renderTable(character, displayAppearances);
    const choice = await promptSelection(
      rl,
      character,
      displayAppearances.length,
    );

    if (choice === displayAppearances.length + 1) {
      // Voice Design
      const designId = `${character.toLowerCase().replace(/\s+/g, "-")}-voice-design`;
      if (!registry[character]!.appearances.some((a) => a.id === designId)) {
        registry[character]!.appearances.push({
          id: designId,
          mediaTitle: null,
          year: null,
          voiceActor: null,
          mediaType: "voice_design",
          youtubeSearchTerms: [],
          notes: "User selected auto-generated voice.",
          voice: null,
        });
      }
      console.log(`   ↳ Auto-generated voice for ${character}`);
    } else {
      const selected = displayAppearances[choice - 1]!;
      const id = generateAppearanceId(character, selected.mediaTitle);
      const existing = registry[character]!.appearances.find(
        (a) => a.id === id,
      );
      if (existing && !existing.voice) {
        existing.voice = {
          voiceId: "",
          voiceType: "ivc",
          status: "needs_clips",
          createdAt: new Date().toISOString(),
        };
      }
      console.log(
        `   ↳ ${selected.mediaTitle} — ${selected.voiceActor} (needs_clips)`,
      );
    }
  }

  rl.close();
  await saveRegistry(registry);

  // ── Cast selection for known characters ───────────────────────────────────
  const castSelections = await loadCastSelections(issueDir);

  for (const character of knownCharNames) {
    const entry = registry[character];
    if (!entry) continue;

    const readyApps = getReadyAppearances(entry);
    if (readyApps.length === 0) {
      // Shouldn't happen: known characters should have a ready voice
      console.log(
        `   ⚠️  ${character} listed as known but has no ready appearances — treating as new`,
      );
      continue;
    }

    if (readyApps.length === 1) {
      const app = readyApps[0]!;
      castSelections[character] = {
        appearanceId: app.id,
        voiceId: app.voice!.voiceId,
      };
      console.log(`   ✓ ${character} → ${app.id} (auto-selected)`);
    } else {
      console.log(
        `\n── ${character} has ${readyApps.length} voices — pick one for this issue:`,
      );
      readyApps.forEach((a, i) => {
        const title = a.mediaTitle
          ? `${a.mediaTitle} (${a.year})`
          : "Voice Design";
        console.log(
          `   ${i + 1}. ${title}${a.voiceActor ? ` — ${a.voiceActor}` : ""}`,
        );
      });

      const rl2 = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const choice = await new Promise<number>((resolve) => {
        const ask = () => {
          rl2.question(
            `Which voice for ${character}? [1-${readyApps.length}]: `,
            (answer) => {
              const n = parseInt(answer.trim(), 10);
              if (!isNaN(n) && n >= 1 && n <= readyApps.length) {
                resolve(n);
              } else {
                ask();
              }
            },
          );
        };
        ask();
      });
      rl2.close();

      const app = readyApps[choice - 1]!;
      castSelections[character] = {
        appearanceId: app.id,
        voiceId: app.voice!.voiceId,
      };
      console.log(`   ↳ ${app.id}`);
    }
  }

  if (knownCharNames.length > 0) {
    await saveCastSelections(issueDir, castSelections);
    console.log(
      `\n💾 cast-selections.json updated (${knownCharNames.length} known characters)`,
    );
  }

  // Summary
  const needsClips = newCharNames.filter((c) => {
    const entry = registry[c];
    return entry?.appearances.some((a) => a.voice?.status === "needs_clips");
  });

  console.log(
    `\n✅ Registry updated — ${allNewCharNames.length} new (${namedCharNames.length} named, ${genericCharNames.length} generic → Voice Design), ${knownCharNames.length} known`,
  );

  if (needsClips.length > 0) {
    console.log(`\n🎯 Characters needing voice clips (${needsClips.length}):`);
    for (const c of needsClips) {
      const app = registry[c]?.appearances.find(
        (a) => a.voice?.status === "needs_clips",
      );
      if (app) {
        console.log(`   ${c}: ${app.mediaTitle} (${app.year})`);
        if (app.youtubeSearchTerms[0]) {
          console.log(`      Search: "${app.youtubeSearchTerms[0]}"`);
        }
      }
    }
    console.log();
  }
}

async function main() {
  const args = parseArgs();

  if (args.mode === "character") {
    await runCharacterMode(args.character!, args.franchise ?? args.character!);
  } else {
    await runBookMode(args.book!, args.issue!, args.db);
  }
}

main().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});

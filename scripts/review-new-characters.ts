#!/usr/bin/env node

import fs from "fs-extra";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as readline from "readline";
import { loadRegistry, hasReadyVoice } from "./utils/registry.js";
import type { CharacterVoiceEntry } from "./generate-character-voice-descriptions.js";
import { supabase } from "./lib/supabase.js";
import { analyzeNewCharacterQueue } from "./utils/new-character-queue.js";

async function upsertAliasInDb(alias: string, canonical: string) {
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.SUPABASE_SECRET_KEY
  ) {
    return;
  }
  try {
    const { error } = await supabase.from("aliases").upsert(
      {
        alias: alias.toLowerCase().trim(),
        canonical,
        scope: "global",
        scope_id: null,
      },
      { onConflict: "alias,scope,scope_id" },
    );
    if (error) {
      console.warn(`  ⚠ DB alias upsert: ${error.message}`);
    }
  } catch (e) {
    console.warn(`  ⚠ DB alias upsert: ${(e as Error).message}`);
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");
const ALIAS_MAP_PATH = join(PROJECT_ROOT, "data", "alias-map.json");

type NewCharsMap = Record<string, CharacterVoiceEntry>;
type BubbleEntry = { type?: string; speaker?: string };
type Annotation = { type: "renamed" | "merged"; from: string };

function parseArgs(): { book: string; issue: string; auto: boolean; db: boolean } {
  const args = process.argv.slice(2);
  let book = process.env.COMIC_BOOK ?? "";
  let issue = process.env.COMIC_ISSUE ?? "";
  let auto = false;
  let db = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg.startsWith("--book=")) book = arg.split("=")[1]?.trim() ?? book;
    if (arg === "--book") {
      const next = args[i + 1];
      if (next) book = next.trim();
    }
    if (arg.startsWith("--issue=")) {
      const v = arg.split("=")[1]?.trim();
      if (v) issue = v.startsWith("issue-") ? v : `issue-${v}`;
    }
    if (arg === "--issue") {
      const next = args[i + 1];
      if (next) issue = next.startsWith("issue-") ? next : `issue-${next}`;
    }
    if (arg === "--auto") auto = true;
    if (arg === "--db") db = true;
  }

  if (!book) {
    console.error("❌ --book is required");
    process.exit(1);
  }
  if (!issue) {
    console.error("❌ --issue is required");
    process.exit(1);
  }

  return { book, issue, auto, db };
}

function applyAlias(name: string, aliasMap: Record<string, string>): string {
  return aliasMap[name.toLowerCase().trim()] ?? name;
}

async function runReviewNewCharactersDbMode(
  book: string,
  issue: string,
): Promise<void> {
  const SEP = "─".repeat(62);
  const adminUrl = `/admin/${book}/${issue}/review/new-characters`;

  const { pendingCount } = await analyzeNewCharacterQueue(supabase, book, issue, {
    projectRoot: PROJECT_ROOT,
  });

  if (pendingCount > 0) {
    const { error } = await supabase
      .from("issues")
      .update({
        pipeline_step: "review-new-characters",
        pipeline_paused: true,
        pipeline_paused_at: "review-new-characters",
        pipeline_paused_url: adminUrl,
      })
      .eq("book_id", book)
      .eq("id", issue);

    if (error) {
      console.warn(`  ⚠ issues pipeline pause update: ${error.message}`);
    }

    console.log(`\n${SEP}`);
    console.log("── Review new characters ──────────────────────────────");
    console.log(`  ${pendingCount} character(s) awaiting review.`);
    console.log(`  Open: ${adminUrl}`);
    console.log(`  Re-run after completing review to continue.`);
    console.log(`${SEP}\n`);
    process.exit(2);
  }

  await supabase
    .from("issues")
    .update({
      pipeline_paused: false,
      pipeline_paused_at: null,
      pipeline_paused_url: null,
    })
    .eq("book_id", book)
    .eq("id", issue)
    .eq("pipeline_paused_at", "review-new-characters");

  console.log(`\n✅ No new characters awaiting review — continuing pipeline.\n`);
}

async function main() {
  const { book, issue, auto, db } = parseArgs();

  if (db) {
    await runReviewNewCharactersDbMode(book, issue);
    process.exit(0);
  }

  const ISSUE_DIR = join(PROJECT_ROOT, "assets", "comics", book, issue);
  const BUBBLES_PATH = join(ISSUE_DIR, "bubbles.json");
  const NEW_CHARS_PATH = join(ISSUE_DIR, "new-characters.json");
  const KNOWN_CHARS_PATH = join(ISSUE_DIR, "known-characters.json");
  const SEP = "─".repeat(62);

  const aliasMap: Record<string, string> = await fs.readJson(ALIAS_MAP_PATH);

  // Collect SPEECH speakers from bubbles.json
  const bubblesData = (await fs.readJson(BUBBLES_PATH)) as Record<
    string,
    BubbleEntry[]
  >;
  const rawSpeakers = new Set<string>();
  for (const bubbles of Object.values(bubblesData)) {
    for (const bubble of bubbles) {
      if (bubble.type === "SPEECH" && bubble.speaker) {
        rawSpeakers.add(bubble.speaker);
      }
    }
  }
  const speakerSet = new Set<string>(
    [...rawSpeakers].map((s) => applyAlias(s, aliasMap)),
  );

  if (!(await fs.pathExists(NEW_CHARS_PATH))) {
    console.error(`❌ Not found: ${NEW_CHARS_PATH}`);
    console.error("   Run clean-voice-descriptions first.");
    process.exit(1);
  }

  let newChars: NewCharsMap = await fs.readJson(NEW_CHARS_PATH);
  let knownChars: NewCharsMap = (await fs.pathExists(KNOWN_CHARS_PATH))
    ? ((await fs.readJson(KNOWN_CHARS_PATH)) as NewCharsMap)
    : {};

  console.log(`\n${SEP}`);
  console.log("  Review new characters before voice research");
  console.log(
    `  ${rawSpeakers.size} characters in bubbles.json  |  ${Object.keys(newChars).length} in new-characters.json`,
  );
  console.log(SEP);

  // ── Prune phase ──────────────────────────────────────────────────────────────
  console.log("\n  Pruning characters not found in bubbles.json...");

  const toPrune = Object.keys(newChars).filter(
    (name) => !speakerSet.has(applyAlias(name, aliasMap)),
  );

  if (toPrune.length === 0) {
    console.log("  All characters found in bubbles.json — nothing pruned.");
  } else {
    for (const name of toPrune) {
      console.log(`  ✗ ${name} — removed (not in bubbles.json)`);
      delete newChars[name];
    }
  }

  // Re-normalize to collapse any alias-resolved duplicates
  const deduped: NewCharsMap = {};
  for (const [name, entry] of Object.entries(newChars)) {
    const canonical = applyAlias(name, aliasMap);
    if (deduped[canonical]) {
      if (entry.description.length > deduped[canonical]!.description.length) {
        deduped[canonical] = {
          ...deduped[canonical]!,
          description: entry.description,
          named: entry.named,
        };
      }
    } else {
      deduped[canonical] = entry;
    }
  }
  newChars = deduped;

  const remaining = Object.keys(newChars).length;
  console.log(`\n  ${remaining} characters remaining after prune.\n`);

  // ── Interactive alias phase ───────────────────────────────────────────────
  const isInteractive = !auto && process.stdin.isTTY;
  const annotations: Record<string, Annotation> = {};

  if (isInteractive && remaining > 0) {
    const total = remaining;
    const charQueue = Object.keys(newChars).sort();
    const registry = await loadRegistry();
    // Names accepted as-is during this session, in order
    const confirmed: string[] = [];

    console.log(SEP);
    console.log(`  Reviewing each character (${total} total)`);
    console.log(SEP);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const ask = (q: string) =>
      new Promise<string>((resolve) => rl.question(q, resolve));

    for (let qi = 0; qi < charQueue.length; qi++) {
      const currentName = charQueue[qi]!;
      // Skip if already consumed by a prior alias (e.g. promoted to known via earlier merge)
      if (!newChars[currentName]) continue;

      const entry = newChars[currentName]!;
      const tag = entry.named ? "[named]" : "[generic]";
      const headerPrefix = `── ${qi + 1}/${total} `;
      const headerSuffix = "─".repeat(Math.max(0, 62 - headerPrefix.length));
      console.log(`\n${headerPrefix}${headerSuffix}`);
      console.log(`  ${currentName}  ${tag}`);

      let done = false;
      while (!done) {
        console.log();
        console.log("  [1] New character — research appearances");
        console.log("  [2] Alias to existing character");
        console.log();

        const choice = (await ask("Choice [1/2]: ")).trim();

        if (choice === "1") {
          console.log(`  ✓ Accepted: "${currentName}"`);
          confirmed.push(currentName);
          done = true;
        } else if (choice === "2") {
          // Show confirmed-so-far list
          if (confirmed.length > 0) {
            console.log("\n  Confirmed so far:");
            const COLS = 3;
            const COL_W = 24;
            for (let ci = 0; ci < confirmed.length; ci++) {
              const label = `${String(ci + 1).padStart(3)}. ${confirmed[ci]}`;
              if (ci % COLS === 0) process.stdout.write("  ");
              process.stdout.write(label.padEnd(COL_W));
              if (ci % COLS === COLS - 1 || ci === confirmed.length - 1) {
                process.stdout.write("\n");
              }
            }
          } else {
            console.log("\n  (no confirmed characters yet)");
          }
          console.log("\n  Or type a name:");
          console.log();

          // Prompt for alias target; undefined → go back to [1/2]
          let aliasTarget: string | undefined;
          let backToMenu = false;
          while (!aliasTarget && !backToMenu) {
            const input = (
              await ask(`Map "${currentName}" to [#/name]: `)
            ).trim();

            if (!input) {
              backToMenu = true;
              break;
            }

            const num = parseInt(input, 10);
            if (!isNaN(num)) {
              if (confirmed.length === 0) {
                console.log("  ⚠  No confirmed characters yet — type a name");
                continue;
              }
              if (num < 1 || num > confirmed.length) {
                console.log(
                  `  ⚠  Enter a number between 1 and ${confirmed.length}, or type a name`,
                );
                continue;
              }
              aliasTarget = confirmed[num - 1]!;
            } else {
              aliasTarget = input;
            }
          }

          if (backToMenu) continue; // re-show [1/2] menu for this character

          const targetName = aliasTarget!;
          const oldEntry = newChars[currentName]!;

          // Write alias immediately so it survives a crash
          aliasMap[currentName.toLowerCase().trim()] = targetName;
          await fs.writeJson(ALIAS_MAP_PATH, aliasMap, { spaces: 2 });
          // Also push to DB so live app picks it up immediately
          await upsertAliasInDb(currentName, targetName);

          if (knownChars[targetName]) {
            delete newChars[currentName];
            console.log(
              `  ✓ Aliased: "${currentName}" → "${targetName}" (merged with existing known entry)`,
            );
          } else if (newChars[targetName]) {
            const existing = newChars[targetName]!;
            if (oldEntry.description.length > existing.description.length) {
              newChars[targetName] = {
                ...existing,
                description: oldEntry.description,
                named: oldEntry.named,
              };
            }
            delete newChars[currentName];
            annotations[targetName] = { type: "merged", from: currentName };
            console.log(
              `  ✓ Aliased: "${currentName}" → "${targetName}" (merged with existing ${targetName} entry)`,
            );
          } else {
            newChars[targetName] = oldEntry;
            delete newChars[currentName];
            const prior = annotations[currentName];
            annotations[targetName] = prior ?? {
              type: "renamed",
              from: currentName,
            };
            if (prior) delete annotations[currentName];
            console.log(
              `  ✓ Aliased: "${currentName}" → "${targetName}" (saved to alias-map.json)`,
            );
          }

          // Promote to known if registry now has a ready voice
          if (newChars[targetName]) {
            const regEntry = registry[targetName];
            if (regEntry && hasReadyVoice(regEntry)) {
              knownChars[targetName] = newChars[targetName]!;
              delete newChars[targetName];
              delete annotations[targetName];
              const ci = confirmed.indexOf(targetName);
              if (ci !== -1) confirmed.splice(ci, 1);
              console.log(
                `  ✓ "${targetName}" promoted to known-characters (ready voice in registry)`,
              );
            }
          }

          done = true;
        } else if (choice) {
          console.log("  ⚠  Enter 1 or 2");
        }
      }
    }

    rl.close();
  }

  // ── Final confirmation ────────────────────────────────────────────────────
  const finalNewNames = Object.keys(newChars).sort();
  const finalKnownNames = Object.keys(knownChars).sort();

  console.log(`\n${SEP}`);
  console.log(
    `  Final list — ${finalNewNames.length} characters proceeding to voice research:\n`,
  );

  finalNewNames.forEach((name, i) => {
    const entry = newChars[name]!;
    const tag = entry.named ? "[named]  " : "[generic]";
    const ann = annotations[name];
    let route: string;
    if (ann?.type === "merged") {
      route = `→ merged (was: ${ann.from})`;
    } else {
      const base = entry.named ? "→ research appearances" : "→ Voice Design";
      route = ann ? `${base}  (was: ${ann.from})` : base;
    }
    console.log(
      `  ${String(i + 1).padStart(3)}. ${name.padEnd(26)} ${tag} ${route}`,
    );
  });

  finalKnownNames.forEach((name, i) => {
    const num = String(finalNewNames.length + i + 1).padStart(3);
    console.log(
      `  ${num}. ${name.padEnd(26)} [known]   → skip research (in registry)`,
    );
  });

  console.log();

  if (isInteractive && finalNewNames.length > 0) {
    const rl2 = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = await new Promise<string>((resolve) => {
      rl2.question("Proceed? [Y/n]: ", resolve);
    });
    rl2.close();

    if (answer.trim().toLowerCase() === "n") {
      console.log("  Aborted. Edit new-characters.json manually and re-run.");
      process.exit(0);
    }
  }

  await fs.writeJson(NEW_CHARS_PATH, newChars, { spaces: 2 });
  await fs.writeJson(KNOWN_CHARS_PATH, knownChars, { spaces: 2 });

  console.log(
    `\n✅ Saved: new-characters.json (${finalNewNames.length} entries), known-characters.json (${finalKnownNames.length} entries)`,
  );
}

main().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});

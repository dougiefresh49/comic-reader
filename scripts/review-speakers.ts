#!/usr/bin/env node

import fs from "fs-extra";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as readline from "readline";
import { loadRegistry, hasReadyVoice } from "./utils/registry.js";
import { loadRoster, getRosterAliasMap } from "./utils/roster.js";
import { getCanonicalName, initAliasMap } from "./alias-map.js";
import { supabase } from "./lib/supabase.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

type BubbleEntry = {
  type?: string;
  speaker?: string | null;
  ocr_text?: string;
};
type BubblesData = Record<string, BubbleEntry[]>;
type ReviewedSpeakers = Record<string, string>;

function parseArgs(): {
  book: string;
  issue: string;
  auto: boolean;
  db: boolean;
} {
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
      if (next) {
        const n = next.trim();
        issue = n.startsWith("issue-") ? n : `issue-${n}`;
      }
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

function pageNumFromKey(key: string): number {
  const match = /(\d+)/.exec(key);
  return match ? parseInt(match[1]!, 10) : 0;
}

function displayGrid(
  items: string[],
  startNum: number,
  cols: number,
  colW: number,
): void {
  for (let i = 0; i < items.length; i++) {
    const label = `${String(startNum + i).padStart(3)}. ${items[i]!}`;
    if (i % cols === 0) process.stdout.write("  ");
    process.stdout.write(label.padEnd(colW));
    if (i % cols === cols - 1 || i === items.length - 1) {
      process.stdout.write("\n");
    }
  }
}

function renameAll(
  bubblesData: BubblesData,
  oldName: string,
  newName: string,
): number {
  let count = 0;
  for (const bubbles of Object.values(bubblesData)) {
    for (const bubble of bubbles) {
      if (bubble.speaker === oldName) {
        bubble.speaker = newName;
        count++;
      }
    }
  }
  return count;
}

async function pickFromList(
  currentName: string,
  confirmed: string[],
  registryReadyNames: string[],
  ask: (q: string) => Promise<string>,
): Promise<string | null> {
  let showAll = false;

  while (true) {
    if (confirmed.length > 0) {
      console.log("\n  Confirmed this session:");
      displayGrid(confirmed, 1, 3, 24);
    } else {
      console.log("\n  (no confirmed characters yet)");
    }

    const visibleRegistry = showAll
      ? registryReadyNames
      : registryReadyNames.slice(0, 8);
    const hiddenCount = registryReadyNames.length - visibleRegistry.length;

    if (visibleRegistry.length > 0) {
      console.log("\n  Known from registry:");
      displayGrid(visibleRegistry, confirmed.length + 1, 3, 22);
      if (hiddenCount > 0) {
        console.log(`   (${hiddenCount} more — type ? to see all)`);
      }
    }

    console.log("\n  Or type a name:\n");

    const input = (await ask(`Map "${currentName}" to [#/name]: `)).trim();

    if (!input) return null;

    if (input === "?") {
      showAll = true;
      continue;
    }

    const num = parseInt(input, 10);
    if (!isNaN(num)) {
      const confirmedEnd = confirmed.length;
      const registryEnd = confirmedEnd + visibleRegistry.length;

      if (num >= 1 && num <= confirmedEnd) {
        return confirmed[num - 1]!;
      } else if (num > confirmedEnd && num <= registryEnd) {
        return visibleRegistry[num - confirmedEnd - 1]!;
      } else {
        console.log(
          `  ⚠  Enter a number between 1 and ${registryEnd}, or type a name`,
        );
        continue;
      }
    }

    return input;
  }
}

async function runDbMode(book: string, issue: string): Promise<void> {
  const SEP = "─".repeat(62);
  const adminUrl = `/admin/${book}/${issue}/review/speakers`;

  // Query unique SPEECH speakers from bubbles
  const { data: bubbleRows } = await supabase
    .from("bubbles")
    .select("speaker")
    .eq("book_id", book)
    .eq("issue_id", issue)
    .eq("type", "SPEECH")
    .not("speaker", "is", null);

  const uniqueSpeakers = new Set<string>();
  for (const row of bubbleRows ?? []) {
    if (row.speaker) uniqueSpeakers.add(row.speaker as string);
  }

  if (uniqueSpeakers.size === 0) {
    console.log("\n✅ No speakers found in bubbles — nothing to review.\n");
    return;
  }

  // Check which speakers already have resolved reviews
  const { data: reviewRows } = await supabase
    .from("speaker_reviews")
    .select("original_name, status")
    .eq("book_id", book)
    .eq("issue_id", issue);

  const resolvedNames = new Set<string>();
  for (const r of reviewRows ?? []) {
    if ((r.status as string) !== "pending") {
      resolvedNames.add(r.original_name as string);
    }
  }

  // Check for auto-known speakers via aliases + castlist
  const [{ data: aliasRows }, { data: castRows }] = await Promise.all([
    supabase
      .from("aliases")
      .select("alias, canonical")
      .or(`scope.eq.global,and(scope.eq.book,scope_id.eq.${book})`),
    supabase
      .from("castlist")
      .select("character")
      .eq("book_id", book)
      .eq("issue_id", issue),
  ]);

  const aliasMap = new Map<string, string>();
  for (const r of (aliasRows ?? []) as Array<{
    alias: string;
    canonical: string;
  }>) {
    aliasMap.set(r.alias.toLowerCase().trim(), r.canonical);
  }
  const castedCharacters = new Set<string>();
  for (const r of (castRows ?? []) as Array<{ character: string }>) {
    castedCharacters.add(r.character);
  }

  let pendingCount = 0;
  for (const name of uniqueSpeakers) {
    if (resolvedNames.has(name)) continue;
    const aliased = aliasMap.get(name.toLowerCase().trim());
    const canonical = aliased ?? name;
    if (castedCharacters.has(canonical)) continue;
    pendingCount++;
  }

  if (pendingCount > 0) {
    await supabase
      .from("issues")
      .update({
        pipeline_step: "review-speakers",
        pipeline_paused: true,
        pipeline_paused_at: "review-speakers",
        pipeline_paused_url: adminUrl,
      })
      .eq("book_id", book)
      .eq("id", issue);

    console.log(`\n${SEP}`);
    console.log("── Review speakers ──────────────────────────────────────");
    console.log(`  ${pendingCount} speaker(s) awaiting review.`);
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
    .eq("pipeline_paused_at", "review-speakers");

  console.log(`\n✅ No speakers awaiting review — continuing pipeline.\n`);
}

async function main() {
  const { book, issue, auto, db } = parseArgs();

  if (db) {
    await runDbMode(book, issue);
    return;
  }

  await initAliasMap();

  const BOOK_DIR = join(PROJECT_ROOT, "assets", "comics", book);
  const ISSUE_DIR = join(BOOK_DIR, issue);
  const BUBBLES_PATH = join(ISSUE_DIR, "bubbles.json");
  const DATA_DIR = join(ISSUE_DIR, "data");
  const REVIEWED_SPEAKERS_PATH = join(DATA_DIR, "reviewed-speakers.json");
  const SEP = "─".repeat(64);

  if (!(await fs.pathExists(BUBBLES_PATH))) {
    console.error(`❌ Not found: ${BUBBLES_PATH}`);
    console.error("   Run get-context first.");
    process.exit(1);
  }

  const bubblesData: BubblesData = await fs.readJson(BUBBLES_PATH);
  const registry = await loadRegistry();
  const roster = await loadRoster(BOOK_DIR);
  const rosterAliasMap = getRosterAliasMap(roster);

  const reviewedSpeakers: ReviewedSpeakers = (await fs.pathExists(
    REVIEWED_SPEAKERS_PATH,
  ))
    ? ((await fs.readJson(REVIEWED_SPEAKERS_PATH)) as ReviewedSpeakers)
    : {};

  // Apply corrections from a prior run (handles regenerated bubbles.json)
  let bubblesModified = false;
  for (const [oldName, newName] of Object.entries(reviewedSpeakers)) {
    if (oldName !== newName) {
      const count = renameAll(bubblesData, oldName, newName);
      if (count > 0) bubblesModified = true;
    }
  }
  if (bubblesModified) {
    await fs.writeJson(BUBBLES_PATH, bubblesData, { spaces: 2 });
  }

  // Collect unique speakers + page/bubble metadata
  type SpeakerInfo = {
    pages: Set<number>;
    bubbleCount: number;
    sampleText: string;
  };
  const speakerMap = new Map<string, SpeakerInfo>();

  for (const [pageKey, bubbles] of Object.entries(bubblesData)) {
    const pageNum = pageNumFromKey(pageKey);
    for (const bubble of bubbles) {
      if (bubble.type === "SPEECH" && bubble.speaker) {
        const name = bubble.speaker;
        if (!speakerMap.has(name)) {
          speakerMap.set(name, {
            pages: new Set(),
            bubbleCount: 0,
            sampleText: bubble.ocr_text ? bubble.ocr_text.slice(0, 60) : "",
          });
        }
        const info = speakerMap.get(name)!;
        info.pages.add(pageNum);
        info.bubbleCount++;
        if (!info.sampleText && bubble.ocr_text) {
          info.sampleText = bubble.ocr_text.slice(0, 60);
        }
      }
    }
  }

  // Classify each speaker: auto-accept known, skip already-reviewed, queue rest
  const autoAccepted: string[] = [];
  const toReview: string[] = [];
  const reviewedValues = new Set(Object.values(reviewedSpeakers));

  // Only auto-accept roster entries from *prior* issues — current-issue entries
  // were just written by get-context and haven't been reviewed yet.
  const isFromPriorIssue = (entryName: string): boolean => {
    const entry = roster[entryName];
    return !!entry && entry.firstSeenIssue !== issue;
  };

  for (const name of speakerMap.keys()) {
    const normalized = getCanonicalName(name);
    const registryEntry = registry[normalized];
    const rosterCanonical = rosterAliasMap[normalized.toLowerCase().trim()];
    if (
      (registryEntry && hasReadyVoice(registryEntry)) ||
      isFromPriorIssue(normalized) ||
      (rosterCanonical && isFromPriorIssue(rosterCanonical))
    ) {
      autoAccepted.push(name);
    } else if (reviewedValues.has(name)) {
      // already reviewed in a prior run — skip
    } else {
      toReview.push(name);
    }
  }

  toReview.sort();

  const totalSpeakers = speakerMap.size;
  const pageCount = Object.keys(bubblesData).length;
  const bookDisplay = book
    .split("-")
    .map((w) => w.toUpperCase())
    .join("-");
  const issueNum = issue.replace("issue-", "");

  console.log(`\n${SEP}`);
  console.log(`  Review speakers — ${bookDisplay}`);
  console.log(
    `  Issue ${issueNum}  |  ${totalSpeakers} unique speakers  |  ${pageCount} pages`,
  );
  console.log(SEP);

  if (autoAccepted.length > 0) {
    console.log("  Known characters (already in registry — auto-accepted):");
    const sorted = [...autoAccepted].sort();
    const displayed = sorted.slice(0, 8);
    displayed.forEach((name, i) => {
      const label = `✓ ${name}`;
      if (i % 4 === 0) process.stdout.write("  ");
      process.stdout.write(label.padEnd(20));
      if (i % 4 === 3 || i === displayed.length - 1) process.stdout.write("\n");
    });
    if (sorted.length > 8) {
      console.log(`  ... (${sorted.length} total)`);
    }
  }

  console.log(`\n  ${toReview.length} unknown speakers to review.`);
  console.log(SEP);

  if (auto || !process.stdin.isTTY) {
    let accepted = 0;
    for (const name of toReview) {
      reviewedSpeakers[name] = name;
      accepted++;
    }
    if (accepted > 0) {
      await fs.ensureDir(DATA_DIR);
      await fs.writeJson(REVIEWED_SPEAKERS_PATH, reviewedSpeakers, {
        spaces: 2,
      });
      console.log(`\n  Auto-accepted ${accepted} unknown speakers.`);
    } else {
      console.log("\n  Nothing new to review.");
    }
    return;
  }

  if (toReview.length === 0) {
    console.log("\n  Nothing to review.");
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = (q: string) =>
    new Promise<string>((resolve) => rl.question(q, resolve));

  await fs.ensureDir(DATA_DIR);

  const total = toReview.length;
  const confirmed: string[] = [];
  let renamedCount = 0;
  let acceptedCount = 0;

  const registryReadyNames = Object.entries(registry)
    .filter(([, entry]) => hasReadyVoice(entry))
    .map(([name]) => name)
    .sort();

  for (let qi = 0; qi < toReview.length; qi++) {
    const currentName = toReview[qi]!;
    const info = speakerMap.get(currentName)!;
    const pageList = [...info.pages].sort((a, b) => a - b).join(", ");
    const confirmedHint =
      confirmed.length === 0
        ? ""
        : ` (${confirmed.length} confirmed: ${confirmed.slice(0, 3).join(", ")}${confirmed.length > 3 ? ", ..." : ""})`;

    const headerPrefix = `── ${qi + 1}/${total} `;
    const headerSuffix = "─".repeat(Math.max(0, 62 - headerPrefix.length));
    console.log(`\n${headerPrefix}${headerSuffix}`);
    console.log(`  "${currentName}"`);
    console.log(
      `  Pages: ${pageList}  (${info.bubbleCount} bubble${info.bubbleCount !== 1 ? "s" : ""})`,
    );
    if (info.sampleText) {
      console.log(`  Sample: "${info.sampleText}"`);
    }

    let done = false;
    while (!done) {
      console.log();
      console.log("  [1] Accept");
      console.log("  [2] Edit (type new name)");
      console.log(`  [3] Choose from list${confirmedHint}`);
      console.log();

      const choice = (await ask("Choice [1-3]: ")).trim();

      if (choice === "1") {
        reviewedSpeakers[currentName] = currentName;
        await fs.writeJson(REVIEWED_SPEAKERS_PATH, reviewedSpeakers, {
          spaces: 2,
        });
        confirmed.push(currentName);
        acceptedCount++;
        console.log(`  ✓ Accepted: "${currentName}"`);
        done = true;
      } else if (choice === "2") {
        const newName = (await ask("New name: ")).trim();
        if (!newName) continue;

        const count = renameAll(bubblesData, currentName, newName);
        await fs.writeJson(BUBBLES_PATH, bubblesData, { spaces: 2 });
        reviewedSpeakers[currentName] = newName;
        await fs.writeJson(REVIEWED_SPEAKERS_PATH, reviewedSpeakers, {
          spaces: 2,
        });
        confirmed.push(newName);
        renamedCount++;
        console.log(
          `  ✓ Renamed: "${currentName}" → "${newName}" (${count} bubble${count !== 1 ? "s" : ""} updated)`,
        );
        done = true;
      } else if (choice === "3") {
        const result = await pickFromList(
          currentName,
          confirmed,
          registryReadyNames,
          ask,
        );

        if (result === null) continue;

        if (result === currentName) {
          reviewedSpeakers[currentName] = currentName;
          await fs.writeJson(REVIEWED_SPEAKERS_PATH, reviewedSpeakers, {
            spaces: 2,
          });
          confirmed.push(currentName);
          acceptedCount++;
          console.log(`  ✓ Accepted: "${currentName}"`);
        } else {
          const count = renameAll(bubblesData, currentName, result);
          await fs.writeJson(BUBBLES_PATH, bubblesData, { spaces: 2 });
          reviewedSpeakers[currentName] = result;
          await fs.writeJson(REVIEWED_SPEAKERS_PATH, reviewedSpeakers, {
            spaces: 2,
          });
          confirmed.push(result);
          renamedCount++;
          console.log(
            `  ✓ Renamed: "${currentName}" → "${result}" (${count} bubble${count !== 1 ? "s" : ""} updated)`,
          );
        }
        done = true;
      } else if (choice) {
        console.log("  ⚠  Enter 1, 2, or 3");
      }
    }
  }

  rl.close();

  console.log(`\n${SEP}`);
  console.log(`  Review complete. ${total} speakers reviewed.`);
  console.log(`  Renamed: ${renamedCount}   Accepted: ${acceptedCount}`);
  console.log(`  bubbles.json updated.`);
  console.log(SEP);
}

main().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});

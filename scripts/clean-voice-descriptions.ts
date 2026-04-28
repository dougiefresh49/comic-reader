import fs from "fs-extra";
import { getCanonicalName, initAliasMap } from "./alias-map.js";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { loadRegistry, hasReadyVoice } from "./utils/registry.js";
import { loadRoster, getRosterAliasMap } from "./utils/roster.js";
import type { CharacterVoiceEntry } from "./generate-character-voice-descriptions.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

function parseArgs(): { book: string; issue: string } {
  const args = process.argv.slice(2);
  let book = process.env.COMIC_BOOK ?? "tmnt-mmpr-iii";
  let issue = process.env.COMIC_ISSUE ?? "issue-1";

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
      if (next) issue = next.startsWith("issue-") ? next : `issue-${next}`;
    }
  }

  return { book, issue };
}

type LegacyOrNewEntry = string | CharacterVoiceEntry;
type NormalizedMap = Record<string, CharacterVoiceEntry>;

function normalizeEntry(value: LegacyOrNewEntry): CharacterVoiceEntry {
  if (typeof value === "string") return { description: value, named: true };
  return value;
}

async function main() {
  const { book, issue } = parseArgs();
  await initAliasMap();
  const ISSUE_DIR = join(PROJECT_ROOT, "assets", "comics", book, issue);
  const BOOK_DIR = join(PROJECT_ROOT, "assets", "comics", book);
  const INPUT_PATH = join(ISSUE_DIR, "character-voice-descriptions.json");
  const NEW_CHARS_PATH = join(ISSUE_DIR, "new-characters.json");
  const KNOWN_CHARS_PATH = join(ISSUE_DIR, "known-characters.json");

  const rawData = (await fs.readJson(INPUT_PATH)) as Record<
    string,
    LegacyOrNewEntry
  >;
  const cleanedData: NormalizedMap = {};

  // Load roster aliases (take precedence over static alias-map)
  const roster = await loadRoster(BOOK_DIR);
  const rosterAliasMap = getRosterAliasMap(roster);

  console.log(`Processing ${Object.keys(rawData).length} entries...`);

  for (const [originalName, rawEntry] of Object.entries(rawData)) {
    const entry = normalizeEntry(rawEntry);

    // Roster aliases take precedence, then fall through to static alias-map
    const lowerName = originalName.toLowerCase().trim();
    const canonicalName =
      rosterAliasMap[lowerName] ?? getCanonicalName(originalName);

    if (cleanedData[canonicalName]) {
      if (
        entry.description.length >
        cleanedData[canonicalName]!.description.length
      ) {
        cleanedData[canonicalName] = {
          ...cleanedData[canonicalName]!,
          description: entry.description,
          named: entry.named,
        };
      }
    } else {
      cleanedData[canonicalName] = entry;
    }
  }

  // Cross-reference with registry to split into new vs known
  const registry = await loadRegistry();
  const newChars: NormalizedMap = {};
  const knownChars: NormalizedMap = {};

  for (const [name, entry] of Object.entries(cleanedData)) {
    const regEntry = registry[name];
    if (regEntry && hasReadyVoice(regEntry)) {
      knownChars[name] = entry;
    } else {
      newChars[name] = entry;
    }
  }

  await fs.outputJson(NEW_CHARS_PATH, newChars, { spaces: 2 });
  await fs.outputJson(KNOWN_CHARS_PATH, knownChars, { spaces: 2 });

  const totalIn = Object.keys(rawData).length;
  const totalOut = Object.keys(cleanedData).length;
  console.log(`✅ Cleaned ${totalIn} → ${totalOut} unique characters`);
  console.log(
    `   ${Object.keys(newChars).length} new (need voice setup) → new-characters.json`,
  );
  console.log(
    `   ${Object.keys(knownChars).length} known (in registry) → known-characters.json`,
  );
}

main();

import fs from "fs-extra";
import { getCanonicalName } from "./alias-map.js";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { loadRegistry, hasReadyVoice } from "./utils/registry.js";

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

type CharacterVoiceMap = Record<string, string>;

async function main() {
  const { book, issue } = parseArgs();
  const ISSUE_DIR = join(PROJECT_ROOT, "assets", "comics", book, issue);
  const INPUT_PATH = join(ISSUE_DIR, "character-voice-descriptions.json");
  const NEW_CHARS_PATH = join(ISSUE_DIR, "new-characters.json");
  const KNOWN_CHARS_PATH = join(ISSUE_DIR, "known-characters.json");

  const rawData = (await fs.readJson(INPUT_PATH)) as CharacterVoiceMap;
  const cleanedData: CharacterVoiceMap = {};

  console.log(`Processing ${Object.keys(rawData).length} entries...`);

  for (const [originalName, description] of Object.entries(rawData)) {
    const canonicalName = getCanonicalName(originalName);

    if (cleanedData[canonicalName]) {
      if (description.length > cleanedData[canonicalName]!.length) {
        cleanedData[canonicalName] = description;
      }
    } else {
      cleanedData[canonicalName] = description;
    }
  }

  // Cross-reference with registry to split into new vs known
  const registry = await loadRegistry();
  const newChars: CharacterVoiceMap = {};
  const knownChars: CharacterVoiceMap = {};

  for (const [name, description] of Object.entries(cleanedData)) {
    const entry = registry[name];
    if (entry && hasReadyVoice(entry)) {
      knownChars[name] = description;
    } else {
      newChars[name] = description;
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

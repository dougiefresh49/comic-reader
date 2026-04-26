import fs from "fs-extra";
import { join } from "path";
import type {
  BookConfig,
  CharacterRoster,
  CharacterRosterEntry,
} from "../types/book-config.js";

export async function loadBookConfig(
  bookDir: string,
): Promise<BookConfig | null> {
  const configPath = join(bookDir, "book-config.json");
  try {
    if (await fs.pathExists(configPath)) {
      return (await fs.readJson(configPath)) as BookConfig;
    }
  } catch (err) {
    console.warn(
      `⚠️  Failed to load book-config.json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return null;
}

export async function loadRoster(bookDir: string): Promise<CharacterRoster> {
  const rosterPath = join(bookDir, "character-roster.json");
  try {
    if (await fs.pathExists(rosterPath)) {
      return (await fs.readJson(rosterPath)) as CharacterRoster;
    }
  } catch (err) {
    console.warn(
      `⚠️  Failed to load character-roster.json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return {};
}

export async function saveRoster(
  bookDir: string,
  roster: CharacterRoster,
): Promise<void> {
  const rosterPath = join(bookDir, "character-roster.json");
  await fs.writeJson(rosterPath, roster, { spaces: 2 });
}

export function formatRosterForPrompt(roster: CharacterRoster): string {
  const entries = Object.values(roster);
  if (entries.length === 0) return "";

  const lines = entries.map((entry) => {
    let line = `- ${entry.canonicalName}`;
    if (entry.description) line += `: ${entry.description}`;
    if (entry.aliases.length > 0)
      line += `. Also goes by: ${entry.aliases.join(", ")}`;
    return line;
  });

  return `Characters already identified in this book (use these exact canonical names if you see them):\n${lines.join("\n")}`;
}

export function getRosterAliasMap(
  roster: CharacterRoster,
): Record<string, string> {
  const aliasMap: Record<string, string> = {};
  for (const entry of Object.values(roster)) {
    for (const alias of entry.aliases) {
      aliasMap[alias.toLowerCase().trim()] = entry.canonicalName;
    }
  }
  return aliasMap;
}

export function addCharacterToRoster(
  roster: CharacterRoster,
  name: string,
  issue: string,
  page: number,
): CharacterRoster {
  if (roster[name]) return roster;

  const aliasMap = getRosterAliasMap(roster);
  if (aliasMap[name.toLowerCase().trim()]) return roster;

  const entry: CharacterRosterEntry = {
    canonicalName: name,
    aliases: [],
    firstSeenIssue: issue,
    firstSeenPage: page,
  };

  return { ...roster, [name]: entry };
}

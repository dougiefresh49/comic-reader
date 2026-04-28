import fs from "fs-extra";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type {
  CharacterRegistry,
  CharacterRegistryEntry,
  AppearanceEntry,
  CastSelections,
} from "../types/registry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "../..");

const REGISTRY_PATH = join(PROJECT_ROOT, "data", "character-registry.json");

export async function loadRegistry(): Promise<CharacterRegistry> {
  try {
    if (await fs.pathExists(REGISTRY_PATH)) {
      return (await fs.readJson(REGISTRY_PATH)) as CharacterRegistry;
    }
  } catch {
    // start fresh
  }
  return {};
}

export async function saveRegistry(registry: CharacterRegistry): Promise<void> {
  await fs.ensureDir(dirname(REGISTRY_PATH));
  await fs.writeJson(REGISTRY_PATH, registry, { spaces: 2 });
}

export function hasReadyVoice(entry: CharacterRegistryEntry): boolean {
  return entry.appearances.some((a) => a.voice?.status === "ready");
}

export function getReadyAppearances(
  entry: CharacterRegistryEntry,
): AppearanceEntry[] {
  return entry.appearances.filter((a) => a.voice?.status === "ready");
}

export function getMostRecentReadyAppearance(
  entry: CharacterRegistryEntry,
): AppearanceEntry | undefined {
  const ready = getReadyAppearances(entry);
  if (ready.length === 0) return undefined;
  return ready.sort((a, b) => {
    const aDate = a.voice?.createdAt ?? "";
    const bDate = b.voice?.createdAt ?? "";
    return bDate.localeCompare(aDate);
  })[0];
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

export function generateAppearanceId(
  characterName: string,
  mediaTitle: string,
): string {
  return `${slugify(characterName)}-${slugify(mediaTitle)}`;
}

export async function loadCastSelections(
  issueDir: string,
): Promise<CastSelections> {
  const path = join(issueDir, "cast-selections.json");
  try {
    if (await fs.pathExists(path)) {
      return (await fs.readJson(path)) as CastSelections;
    }
  } catch {
    // start fresh
  }
  return {};
}

export async function saveCastSelections(
  issueDir: string,
  selections: CastSelections,
): Promise<void> {
  const path = join(issueDir, "cast-selections.json");
  await fs.writeJson(path, selections, { spaces: 2 });
}

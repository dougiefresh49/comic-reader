import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ALIAS_MAP_PATH = join(__dirname, "..", "data", "alias-map.json");

export const aliasMap: Record<string, string> = JSON.parse(
  readFileSync(ALIAS_MAP_PATH, "utf-8"),
);

// Helper to normalize names (trim, lowercase) for lookup
export const getCanonicalName = (name: string): string => {
  const cleanName = name.toLowerCase().trim();
  return aliasMap[cleanName] ?? name;
};

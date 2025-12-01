import fs from "fs-extra";
import { getCanonicalName } from "./alias-map.js";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");
const INPUT_PATH = join(
  PROJECT_ROOT,
  "assets",
  "comics",
  "tmnt-mmpr-iii",
  "character-voice-descriptions.json",
);
const OUTPUT_PATH = join(PROJECT_ROOT, "data", "source-material.json"); // This becomes your master source file

type CharacterVoiceMap = Record<string, string>;

async function main() {
  // 1. Load the dirty data
  const rawData = (await fs.readJson(INPUT_PATH)) as CharacterVoiceMap;
  const cleanedData: CharacterVoiceMap = {};

  console.log(`Processing ${Object.keys(rawData).length} entries...`);

  for (const [originalName, description] of Object.entries(rawData)) {
    // 2. Get the canonical name (e.g. "Tommy" -> "Green Ranger")
    const canonicalName = getCanonicalName(originalName);

    // 3. Deduplicate
    // If we already have this character, we might want to keep the longer/better description.
    // For now, we'll just overwrite or keep the first one.
    // Let's pick the longest description as it's likely the most detailed.
    if (cleanedData[canonicalName]) {
      if (description.length > cleanedData[canonicalName]!.length) {
        cleanedData[canonicalName] = description;
      }
    } else {
      cleanedData[canonicalName] = description;
    }
  }

  // 4. Save the clean file
  await fs.outputJson(OUTPUT_PATH, cleanedData, { spaces: 2 });

  console.log(`✅ Cleaned data saved to ${OUTPUT_PATH}`);
  console.log(
    `   Reduced from ${Object.keys(rawData).length} to ${Object.keys(cleanedData).length} unique characters.`,
  );
}

main();

#!/usr/bin/env node

import fs from "fs-extra";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as readline from "readline";
import { execSync } from "child_process";
import {
  GoogleGenAI,
  createPartFromBase64,
  createPartFromText,
} from "@google/genai";
import { env } from "~/env.mjs";
import {
  GEMINI_HIGH,
  GEMINI_MEDIUM,
  VENICE_IMAGE_CHAR_REF,
} from "./utils/models.js";
import { generateImage, getBalance } from "./utils/venice-client.js";
import { loadRegistry, saveRegistry, hasReadyVoice } from "./utils/registry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

// ─── Step registry ────────────────────────────────────────────────────────────

const STEPS = ["setup-series", "lock-characters"] as const;
type Step = (typeof STEPS)[number];

// ─── Checkpoint helpers ───────────────────────────────────────────────────────

interface Checkpoint {
  completedSteps: string[];
  lastRunAt: string;
}

function bookCheckpointPath(book: string): string {
  return join(
    PROJECT_ROOT,
    "assets",
    "episodes",
    book,
    "episode-checkpoint.json",
  );
}

async function loadCheckpoint(path: string): Promise<Checkpoint> {
  try {
    if (await fs.pathExists(path)) {
      return (await fs.readJson(path)) as Checkpoint;
    }
  } catch {
    // start fresh
  }
  return { completedSteps: [], lastRunAt: "" };
}

async function saveCheckpoint(path: string, cp: Checkpoint): Promise<void> {
  await fs.ensureDir(dirname(path));
  cp.lastRunAt = new Date().toISOString();
  await fs.writeJson(path, cp, { spaces: 2 });
}

// ─── Arg parsing ──────────────────────────────────────────────────────────────

interface Args {
  book: string;
  issue: string;
  onlyStep: Step | null;
  force: boolean;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage: pnpm generate-episode -- --book <name> --issue <n> [options]

Options:
  --book <name>         Book identifier (required)
  --issue <n>           Issue number (required)
  --only-step <step>    Run only this step (${STEPS.join(", ")})
  --force               Re-run even if output already exists
  --help, -h            Show this help

Examples:
  pnpm generate-episode -- --book tmnt-mmpr-iii --issue 1
  pnpm generate-episode -- --book tmnt-mmpr-iii --issue 1 --only-step setup-series
  pnpm generate-episode -- --book tmnt-mmpr-iii --issue 1 --only-step lock-characters --force
`);
    process.exit(0);
  }

  let book = "";
  let issue = "";
  let onlyStep: Step | null = null;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--book=")) {
      book = arg.split("=")[1]?.trim() ?? "";
    } else if (arg === "--book") {
      book = args[++i]?.trim() ?? "";
    } else if (arg.startsWith("--issue=")) {
      const n = arg.split("=")[1]?.trim() ?? "";
      issue = n.startsWith("issue-") ? n : `issue-${n}`;
    } else if (arg === "--issue") {
      const n = args[++i]?.trim() ?? "";
      issue = n.startsWith("issue-") ? n : `issue-${n}`;
    } else if (arg === "--only-step") {
      const s = args[++i]?.trim() ?? "";
      if (!STEPS.includes(s as Step)) {
        console.error(
          `❌ Unknown step: ${s}. Valid steps: ${STEPS.join(", ")}`,
        );
        process.exit(1);
      }
      onlyStep = s as Step;
    } else if (arg === "--force") {
      force = true;
    }
  }

  if (!book) {
    console.error("❌ --book is required");
    process.exit(1);
  }
  if (!issue) {
    console.error("❌ --issue is required");
    process.exit(1);
  }

  return { book, issue, onlyStep, force };
}

// ─── Prompt helper ────────────────────────────────────────────────────────────

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

// ─── JSON extraction helper ───────────────────────────────────────────────────

function extractJson(text: string): string {
  const jsonBlock = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonBlock) return jsonBlock[1]!.trim();
  const codeBlock = text.match(/```\s*([\s\S]*?)\s*```/);
  if (codeBlock) return codeBlock[1]!.trim();
  return text.trim();
}

// ─── Step: setup-series ──────────────────────────────────────────────────────

interface SeriesAesthetic {
  stylePrompt: string;
  palette: string;
  lighting: string;
  lens: string;
  negativePrompt: string;
}

interface SeriesJson {
  bookId: string;
  aesthetic: SeriesAesthetic;
  generatedAt: string;
  sourcePages: string[];
}

async function setupSeries(
  book: string,
  issue: string,
  force: boolean,
): Promise<void> {
  const episodeBookDir = join(PROJECT_ROOT, "assets", "episodes", book);
  const seriesPath = join(episodeBookDir, "series.json");

  if (!force && (await fs.pathExists(seriesPath))) {
    console.log(
      "   series.json already exists — skipping (use --force to regenerate)",
    );
    return;
  }

  const webpDir = join(
    PROJECT_ROOT,
    "assets",
    "comics",
    book,
    issue,
    "pages-webp",
  );
  if (!(await fs.pathExists(webpDir))) {
    console.error(`❌ pages-webp not found: ${webpDir}`);
    process.exit(1);
  }

  const allPages = (await fs.readdir(webpDir))
    .filter((f) => f.endsWith(".webp"))
    .sort();

  if (allPages.length === 0) {
    console.error(`❌ No .webp pages found in ${webpDir}`);
    process.exit(1);
  }

  const n = allPages.length;
  const indices = [0, Math.floor(n / 2), Math.floor((3 * n) / 4)];
  const selectedPages = [...new Set(indices)].map((i) => allPages[i]!);

  console.log(
    `   Sending ${selectedPages.length} pages to Gemini Vision for style analysis...`,
  );
  console.log(`   Pages: ${selectedPages.join(", ")}`);

  const gemini = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

  const imageParts = await Promise.all(
    selectedPages.map(async (page) => {
      const buf = await fs.readFile(join(webpDir, page));
      return createPartFromBase64(buf.toString("base64"), "image/webp");
    }),
  );

  const textPart =
    createPartFromText(`Analyze the visual style of these comic book pages and produce a style description suitable for an AI image generation prompt. Focus on:
- Art style (cel animation, line art weight, shading approach)
- Color palette characteristics
- Lighting and rendering style
- What to avoid (photorealism, wrong art styles)

Return JSON only (no markdown): { "stylePrompt": "...", "palette": "...", "lighting": "...", "lens": "...", "negativePrompt": "..." }`);

  const response = await gemini.models.generateContent({
    model: GEMINI_HIGH,
    contents: [...imageParts, textPart],
  });

  const text = response.text;
  if (!text) throw new Error("No response from Gemini");

  const jsonText = extractJson(text);
  const aesthetic = JSON.parse(jsonText) as SeriesAesthetic;

  const seriesJson: SeriesJson = {
    bookId: book,
    aesthetic,
    generatedAt: new Date().toISOString(),
    sourcePages: selectedPages,
  };

  await fs.ensureDir(episodeBookDir);
  await fs.writeJson(seriesPath, seriesJson, { spaces: 2 });

  console.log("   ✓ series.json written");
  console.log(`   Style: ${aesthetic.stylePrompt}`);
}

// ─── Known visual descriptions ────────────────────────────────────────────────

const KNOWN_VISUAL_DESCRIPTIONS: Record<string, string> = {
  Leonardo:
    "Green humanoid turtle, blue bandana mask, twin katana, blue plastron trim, stoic upright posture",
  Raphael:
    "Green humanoid turtle, red bandana mask, twin sai, stockier muscular build, aggressive stance",
  Michelangelo:
    "Green humanoid turtle, orange bandana mask, nunchucks, most casual relaxed posture",
  Donatello:
    "Green humanoid turtle, purple bandana mask, bo staff, taller and leaner build",
  "Tommy Oliver":
    "White Power Ranger suit, gold trim accents, white helmet with visor, Saba sword",
  Kimberly: "Pink Power Ranger suit, pink helmet with visor, bow weapon",
  Billy: "Blue Power Ranger suit, blue helmet with visor",
  Zack: "Black Power Ranger suit, black helmet with visor",
  Trini: "Yellow Power Ranger suit, yellow helmet with visor",
  Jason: "Red Power Ranger suit, red helmet with visor",
  Zordon:
    "Massive ethereal blue head of an ancient wizard floating in a tall column of energy light, no body",
  "Alpha 5":
    "Short squat robot, gold and red metallic body, large dome head, spindly arms",
  Shredder:
    "Villain in bladed silver samurai armor, winged helmet, dark flowing cape",
  Bebop:
    "Mutant warthog-human hybrid, purple mohawk, sunglasses, purple vest, large tusks",
  Rocksteady:
    "Mutant rhinoceros-human hybrid, army helmet, military camouflage vest, large horn",
};

// ─── Step: lock-characters ────────────────────────────────────────────────────

async function lockCharacters(
  book: string,
  _issue: string,
  force: boolean,
): Promise<void> {
  const episodeBookDir = join(PROJECT_ROOT, "assets", "episodes", book);
  const seriesPath = join(episodeBookDir, "series.json");

  if (!(await fs.pathExists(seriesPath))) {
    console.error("❌ series.json not found — run setup-series first");
    process.exit(1);
  }

  const series = (await fs.readJson(seriesPath)) as SeriesJson;
  const registry = await loadRegistry();
  const gemini = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

  // Collect characters with at least one ready voice
  const readyChars = Object.entries(registry).filter(([, entry]) =>
    hasReadyVoice(entry),
  );

  if (readyChars.length === 0) {
    console.log("   No characters with ready voices found — nothing to do");
    return;
  }

  console.log(
    `   Processing ${readyChars.length} character(s) with ready voices...\n`,
  );

  let generatedCount = 0;
  const charactersDir = join(episodeBookDir, "characters");

  for (let i = 0; i < readyChars.length; i++) {
    const [canonicalName, entry] = readyChars[i]!;

    // Fix 3: explicit guard instead of non-null assertion
    const readyAppearance = entry.appearances.find(
      (a) => a.voice?.status === "ready",
    );
    if (!readyAppearance) {
      console.log(
        `   ⚠️  [${i + 1}/${readyChars.length}] ${canonicalName} — no ready appearance found, skipping`,
      );
      continue;
    }

    process.stdout.write(
      `[${i + 1}/${readyChars.length}] ${canonicalName}... `,
    );

    // 1. Get or generate visualDescription
    let visualDescription = readyAppearance.visualDescription ?? null;

    if (visualDescription) {
      process.stdout.write("visualDescription exists ✓\n");
    } else {
      // Check known hardcoded descriptions first
      const known = KNOWN_VISUAL_DESCRIPTIONS[canonicalName];
      if (known) {
        visualDescription = known;
        process.stdout.write("visualDescription (hardcoded) ✓\n");
      } else {
        // Generate via Gemini
        process.stdout.write("generating visualDescription... ");
        const genPrompt = `Write a concise visual appearance description for ${canonicalName} from ${entry.franchise} as they appear in ${readyAppearance.mediaTitle ?? entry.franchise}. Include: species/humanoid type, distinctive costume colors, signature weapon or accessory, body type. 3-4 sentences. This will be used as an AI image generation prompt.`;

        const resp = await gemini.models.generateContent({
          model: GEMINI_MEDIUM,
          contents: [createPartFromText(genPrompt)],
        });
        visualDescription = resp.text?.trim() ?? null;
        process.stdout.write("✓\n");
      }

      // Fix 1: save immediately after generation, not batched at the end
      if (visualDescription) {
        readyAppearance.visualDescription = visualDescription;
        await saveRegistry(registry);
      }
    }

    if (!visualDescription) {
      console.log(
        `         ⚠️  Could not get visualDescription — skipping image generation`,
      );
      continue;
    }

    // 2. Generate reference image
    const safeCharName = canonicalName
      .replace(/[^a-z0-9-]/gi, "-")
      .replace(/-+/g, "-");
    const charDir = join(episodeBookDir, "characters", safeCharName);
    const refImagePath = join(charDir, "reference.png");
    const refProvPath = join(charDir, "reference.provenance.json");

    if (!force && (await fs.pathExists(refImagePath))) {
      console.log(
        `         reference.png exists — skipping (use --force to regenerate)`,
      );
      continue;
    }

    const imagePrompt = `${visualDescription}, ${series.aesthetic.stylePrompt}, character portrait, facing forward, plain white background, full body visible`;

    process.stdout.write("         Generating reference image... ");

    // Fix 2: read balance from response header, no extra GET request
    const { buffer: imgBuffer, balanceUsd } = await generateImage({
      model: VENICE_IMAGE_CHAR_REF,
      prompt: imagePrompt,
      negativePrompt: series.aesthetic.negativePrompt,
      aspectRatio: "2:3",
      format: "png",
    });

    await fs.ensureDir(charDir);
    await fs.writeFile(refImagePath, imgBuffer);
    generatedCount++; // Fix 4: track count in-loop, not from directory listing

    const provenance = {
      model: VENICE_IMAGE_CHAR_REF,
      characterName: canonicalName,
      appearanceId: readyAppearance.id,
      prompt: imagePrompt,
      negativePrompt: series.aesthetic.negativePrompt,
      generatedAt: new Date().toISOString(),
    };
    await fs.writeJson(refProvPath, provenance, { spaces: 2 });

    const balance = balanceUsd ?? (await getBalance());
    console.log(`✓  ($0.05)  💰 $${balance.toFixed(2)} remaining`);

    // Rate limit: 20 req/min → 3s delay between requests
    if (i < readyChars.length - 1) {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  // Fix 4: use in-loop counter, not directory listing
  console.log(
    `\n✅ Generated ${generatedCount} character reference image(s) this run\n`,
  );

  // Open Finder for review
  if (process.platform === "darwin") {
    console.log("Opening character references in Finder...\n");
    try {
      execSync(`open "${charactersDir}"`);
    } catch {
      // Finder open failure is non-fatal
    }
  }

  // Review loop
  while (true) {
    const answer = await prompt(
      "Review character references in Finder.\nRegenerate specific characters? [enter names comma-separated, or Enter to continue]: ",
    );

    if (!answer) break;

    const namesToRegen = answer
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean);

    for (const name of namesToRegen) {
      const entry = registry[name];
      if (!entry) {
        console.log(`   ⚠️  Character not found in registry: ${name}`);
        continue;
      }
      const readyAppearance = entry.appearances.find(
        (a) => a.voice?.status === "ready",
      );
      if (!readyAppearance) {
        console.log(`   ⚠️  No ready voice for: ${name}`);
        continue;
      }

      const visualDescription =
        readyAppearance.visualDescription ??
        KNOWN_VISUAL_DESCRIPTIONS[name] ??
        null;

      if (!visualDescription) {
        console.log(`   ⚠️  No visualDescription for: ${name} — skipping`);
        continue;
      }

      const safeCharName = name
        .replace(/[^a-z0-9-]/gi, "-")
        .replace(/-+/g, "-");
      const charCharDir = join(episodeBookDir, "characters", safeCharName);

      const imagePrompt = `${visualDescription}, ${series.aesthetic.stylePrompt}, character portrait, facing forward, plain white background, full body visible`;

      process.stdout.write(`   Regenerating ${name}... `);

      const { buffer: imgBuffer, balanceUsd } = await generateImage({
        model: VENICE_IMAGE_CHAR_REF,
        prompt: imagePrompt,
        negativePrompt: series.aesthetic.negativePrompt,
        aspectRatio: "2:3",
        format: "png",
      });

      await fs.ensureDir(charCharDir);
      await fs.writeFile(join(charCharDir, "reference.png"), imgBuffer);
      await fs.writeJson(
        join(charCharDir, "reference.provenance.json"),
        {
          model: VENICE_IMAGE_CHAR_REF,
          characterName: name,
          appearanceId: readyAppearance.id,
          prompt: imagePrompt,
          negativePrompt: series.aesthetic.negativePrompt,
          generatedAt: new Date().toISOString(),
        },
        { spaces: 2 },
      );

      const balance = balanceUsd ?? (await getBalance());
      console.log(`✓  ($0.05)  💰 $${balance.toFixed(2)} remaining`);

      await new Promise((r) => setTimeout(r, 3000));
    }

    if (process.platform === "darwin") {
      try {
        execSync(`open "${charactersDir}"`);
      } catch {
        // non-fatal
      }
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { book, issue, onlyStep, force } = parseArgs();

  console.log(`\n🎬 Episode Generator — ${book} / ${issue}\n`);

  const checkpointPath = bookCheckpointPath(book);
  const checkpoint = await loadCheckpoint(checkpointPath);

  const stepHandlers: Record<Step, () => Promise<void>> = {
    "setup-series": () => setupSeries(book, issue, force),
    "lock-characters": () => lockCharacters(book, issue, force),
  };

  if (onlyStep) {
    console.log(`▶  Running step: ${onlyStep}\n`);
    await stepHandlers[onlyStep]();
    if (!checkpoint.completedSteps.includes(onlyStep)) {
      checkpoint.completedSteps.push(onlyStep);
    }
    await saveCheckpoint(checkpointPath, checkpoint);
    console.log(`\n✅ Step complete: ${onlyStep}`);
    return;
  }

  // Run all incomplete steps in order
  const stepsToRun = STEPS.filter(
    (s) => force || !checkpoint.completedSteps.includes(s),
  );

  if (stepsToRun.length === 0) {
    console.log("✅ All steps already complete. Use --force to re-run.\n");
    return;
  }

  for (const step of stepsToRun) {
    console.log(`▶  Step: ${step}\n`);
    await stepHandlers[step]();
    if (!checkpoint.completedSteps.includes(step)) {
      checkpoint.completedSteps.push(step);
    }
    await saveCheckpoint(checkpointPath, checkpoint);
    console.log(`\n✓ ${step} complete\n`);
  }

  console.log("✅ All steps complete.\n");
}

main().catch((err: unknown) => {
  console.error("❌ Fatal error:", err instanceof Error ? err.message : err);
  process.exit(1);
});

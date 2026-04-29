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
import {
  analyzePage,
  buildShots,
  printShotTable,
  type AudioTimestamp,
  type BubbleInput,
  type ShotPlan,
} from "./utils/shot-planner.js";
import {
  directPagePanels,
  type AudioTimestamp as PanelAudioTimestamp,
  type BubbleManifestEntry,
  type DirectedPanel,
  type PanelDirection,
} from "./utils/panel-director.js";
import {
  detectIssuePanels,
  type DetectedPagePanels,
} from "./utils/roboflow-panels.js";
import {
  cropPageToPanel,
  describeSinglePanel,
  type PanelBubbleSummary,
} from "./utils/panel-describer.js";
import { supabase as supabaseAdmin } from "./lib/supabase.js";
import pLimit from "p-limit";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

// ─── Step registry ────────────────────────────────────────────────────────────

const STEPS = [
  "setup-series",
  "lock-characters",
  "detect-panels",
  "describe-panels",
  "plan-shots",
] as const;
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

// ─── Step: detect-panels (Roboflow) ──────────────────────────────────────────

async function detectPanels(
  book: string,
  issue: string,
  force: boolean,
): Promise<void> {
  // 1. List page numbers we have WebPs for
  const ISSUE_DIR = join(PROJECT_ROOT, "assets", "comics", book, issue);
  const PAGES_DIR = join(ISSUE_DIR, "pages-webp");
  const BUBBLES_PATH = join(ISSUE_DIR, "bubbles.json");
  if (!(await fs.pathExists(PAGES_DIR))) {
    console.error(`❌ Missing ${PAGES_DIR}`);
    process.exit(1);
  }
  const pageFiles = (await fs.readdir(PAGES_DIR))
    .filter((f) => /^page-\d+\.webp$/i.test(f))
    .sort();
  const pageNumbers = pageFiles
    .map((f) => parseInt(/^page-(\d+)\.webp$/i.exec(f)?.[1] ?? "0", 10))
    .filter((n) => n > 0);

  // 2. Skip if panels already populated for this issue and not forcing
  if (!force) {
    const { count } = await supabaseAdmin
      .from("panels")
      .select("id", { count: "exact", head: true })
      .eq("book_id", book)
      .eq("issue_id", issue);
    if (count && count > 0) {
      console.log(
        `   ⏭  ${count} panel(s) already exist for ${book}/${issue} — re-run with --force to redetect.`,
      );
      return;
    }
  }

  // 3. Build a public URL resolver (Supabase CDN) so Roboflow can fetch pages
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) {
    console.error("❌ NEXT_PUBLIC_SUPABASE_URL not set");
    process.exit(1);
  }
  const pageUrl = (n: number) => {
    const padded = String(n).padStart(2, "0");
    return `${supabaseUrl}/storage/v1/object/public/comic-pages/${book}/${issue}/page-${padded}.webp`;
  };

  console.log(
    `\n   🔎 Detecting panels on ${pageNumbers.length} page(s) via Roboflow...\n`,
  );

  const detected = await detectIssuePanels({
    bookId: book,
    issueId: issue,
    pageNumbers,
    pageUrl,
    concurrency: 2,
    delayMs: 750,
  });

  let totalPanels = 0;
  for (const d of detected) {
    console.log(
      `   ✓ page-${String(d.pageNumber).padStart(2, "0")} → ${d.panels.length} panel(s)`,
    );
    totalPanels += d.panels.length;
  }
  console.log(`   ${detected.length} page(s), ${totalPanels} panel(s) total\n`);

  // 4. If forcing, clear existing panels for this issue (cascade nulls bubble FKs).
  if (force) {
    const { error: dErr } = await supabaseAdmin
      .from("panels")
      .delete()
      .eq("book_id", book)
      .eq("issue_id", issue);
    if (dErr) {
      console.warn(`   ⚠ delete existing panels: ${dErr.message}`);
    }
  }

  // 5. Upsert panels rows. panelId is "p<page>-<NN>" sequential.
  console.log("   📦 Writing panels to DB and assigning bubbles...");
  let bubblesAssigned = 0;
  let bubblesUnassigned = 0;

  // Load bubbles.json once for spatial assignment
  const bubblesByPage = (await fs.readJson(BUBBLES_PATH)) as Record<
    string,
    Array<{
      id: string;
      style?: { left: string; top: string; width: string; height: string };
    }>
  >;

  for (const page of detected) {
    const padded = String(page.pageNumber).padStart(2, "0");
    const pageKey = `page-${padded}.jpg`;
    const pageBubbles = bubblesByPage[pageKey] ?? [];

    // Insert panels for this page
    const panelRows = page.panels.map((p, idx) => ({
      book_id: book,
      issue_id: issue,
      page_number: page.pageNumber,
      panel_id: `p${padded}-${String(idx + 1).padStart(2, "0")}`,
      sort_order: idx,
      bounding_box: { x: p.x, y: p.y, w: p.w, h: p.h },
      effect_tags: [] as string[],
      audio_tags: { ambience: [], sfx: [], music_mood: "transition_neutral" },
      source: "roboflow",
      updated_at: new Date().toISOString(),
    }));
    if (panelRows.length === 0) continue;

    const { data: inserted, error: iErr } = await supabaseAdmin
      .from("panels")
      .upsert(panelRows, { onConflict: "book_id,issue_id,panel_id" })
      .select("id, panel_id, bounding_box, sort_order");
    if (iErr) {
      console.warn(`   ⚠ panels upsert page-${padded}: ${iErr.message}`);
      continue;
    }
    const insertedRows = (inserted ?? []) as Array<{
      id: string;
      panel_id: string;
      bounding_box: { x: number; y: number; w: number; h: number };
      sort_order: number;
    }>;

    // Map bubbles to panels by center-in-rect (smallest matching panel wins)
    for (const bubble of pageBubbles) {
      if (!bubble.style) continue;
      const cx =
        (parseFloat(bubble.style.left) + parseFloat(bubble.style.width) / 2) /
        100;
      const cy =
        (parseFloat(bubble.style.top) + parseFloat(bubble.style.height) / 2) /
        100;

      const matches = insertedRows.filter((r) => {
        const b = r.bounding_box;
        return cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h;
      });
      let chosen = matches.sort(
        (a, b) =>
          a.bounding_box.w * a.bounding_box.h -
          b.bounding_box.w * b.bounding_box.h,
      )[0];

      // Fallback: if no panel contains the center, pick the closest by center
      if (!chosen) {
        let bestDist = Infinity;
        for (const r of insertedRows) {
          const px = r.bounding_box.x + r.bounding_box.w / 2;
          const py = r.bounding_box.y + r.bounding_box.h / 2;
          const d = Math.hypot(px - cx, py - cy);
          if (d < bestDist) {
            bestDist = d;
            chosen = r;
          }
        }
      }
      if (!chosen) {
        bubblesUnassigned++;
        continue;
      }
      const { error: uErr } = await supabaseAdmin
        .from("bubbles")
        .update({ panel_id: chosen.id })
        .eq("book_id", book)
        .eq("issue_id", issue)
        .eq("legacy_id", bubble.id);
      if (uErr) {
        bubblesUnassigned++;
      } else {
        bubblesAssigned++;
      }
    }
  }

  console.log(
    `   ✓ ${bubblesAssigned} bubble(s) assigned${bubblesUnassigned > 0 ? `, ${bubblesUnassigned} unassigned` : ""}\n`,
  );

  // 6. Full-page fallback for pages that have bubbles but Roboflow detected
  //    no panels. These are typically splash pages — the whole page IS one
  //    panel. Synthesize a single-panel row with source='heuristic-fullpage'
  //    and pin every unassigned bubble on the page to it.
  console.log("   🩹 Full-page fallback for pages with no detected panels...");
  const pagesWithNoDetections = new Set(
    detected.filter((d) => d.panels.length === 0).map((d) => d.pageNumber),
  );
  let fullPagePanelsCreated = 0;
  let fullPageBubblesAssigned = 0;
  for (const pageKey of Object.keys(bubblesByPage)) {
    const m = /^page-?0*(\d+)/.exec(pageKey);
    if (!m) continue;
    const pageNumber = parseInt(m[1]!, 10);
    // Only synthesize for pages where we explicitly got back 0 panels —
    // pages absent from the detected[] list never reached Roboflow (e.g.
    // network error) and we don't want to silently fabricate for those.
    if (!pagesWithNoDetections.has(pageNumber)) continue;

    const pageBubbles = bubblesByPage[pageKey] ?? [];
    if (pageBubbles.length === 0) continue; // no bubbles, no panel needed

    const padded = String(pageNumber).padStart(2, "0");
    const { data: ins, error: iErr } = await supabaseAdmin
      .from("panels")
      .upsert(
        {
          book_id: book,
          issue_id: issue,
          page_number: pageNumber,
          panel_id: `p${padded}-01`,
          sort_order: 0,
          bounding_box: { x: 0, y: 0, w: 1, h: 1 },
          effect_tags: [],
          audio_tags: {
            ambience: [],
            sfx: [],
            music_mood: "transition_neutral",
          },
          source: "heuristic-fullpage",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "book_id,issue_id,panel_id" },
      )
      .select("id")
      .single();
    if (iErr) {
      console.warn(`   ⚠ full-page panel page-${padded}: ${iErr.message}`);
      continue;
    }
    const panelUuid = (ins as { id?: string } | null)?.id;
    if (!panelUuid) continue;
    fullPagePanelsCreated++;

    const { error: bErr } = await supabaseAdmin
      .from("bubbles")
      .update({ panel_id: panelUuid })
      .eq("book_id", book)
      .eq("issue_id", issue)
      .eq("page_number", pageNumber)
      .is("panel_id", null);
    if (!bErr) fullPageBubblesAssigned += pageBubbles.length;
    console.log(
      `   ✓ page-${padded} → 1 full-page panel (${pageBubbles.length} bubble(s))`,
    );
  }
  if (fullPagePanelsCreated > 0) {
    console.log(
      `   ✓ ${fullPagePanelsCreated} full-page panel(s) created, ${fullPageBubblesAssigned} bubble(s) assigned\n`,
    );
  }
}

// ─── Step: describe-panels (Gemini, populates descriptions + tags) ───────────

async function describePanels(
  book: string,
  issue: string,
  force: boolean,
): Promise<void> {
  const ISSUE_DIR = join(PROJECT_ROOT, "assets", "comics", book, issue);
  const PAGES_DIR = join(ISSUE_DIR, "pages-webp");

  // 1. Read panels + their bubbles from DB
  const { data: panelRows, error: pErr } = await supabaseAdmin
    .from("panels")
    .select(
      "id, panel_id, page_number, sort_order, bounding_box, cinematic_description, effect_tags, source",
    )
    .eq("book_id", book)
    .eq("issue_id", issue)
    .order("page_number")
    .order("sort_order");
  if (pErr) {
    console.error(`❌ panels read: ${pErr.message}`);
    process.exit(1);
  }
  const panels = (panelRows ?? []) as Array<{
    id: string;
    panel_id: string;
    page_number: number;
    sort_order: number;
    bounding_box: { x: number; y: number; w: number; h: number };
    cinematic_description: string | null;
    effect_tags: string[] | null;
    source: string;
  }>;

  if (panels.length === 0) {
    console.error(
      "❌ No panels in DB for this issue. Run --only-step detect-panels first.",
    );
    process.exit(1);
  }

  const todo = force
    ? panels
    : panels.filter(
        (p) =>
          !p.cinematic_description ||
          !p.effect_tags ||
          p.effect_tags.length === 0,
      );

  if (todo.length === 0) {
    console.log(
      `   ⏭  All ${panels.length} panel(s) already described. --force to redo.`,
    );
    return;
  }

  console.log(
    `\n   🎬 Describing ${todo.length} panel(s) of ${panels.length} via ${GEMINI_MEDIUM}...`,
  );

  // 2. Pull all bubbles for this issue once, group by panel_id
  const { data: bubbleRows } = await supabaseAdmin
    .from("bubbles")
    .select(
      "legacy_id, panel_id, type, speaker, emotion, ocr_text, text_with_cues",
    )
    .eq("book_id", book)
    .eq("issue_id", issue)
    .not("panel_id", "is", null)
    .order("sort_order");
  const bubblesByPanel = new Map<string, PanelBubbleSummary[]>();
  for (const b of (bubbleRows ?? []) as Array<{
    legacy_id: string | null;
    panel_id: string;
    type: string;
    speaker: string | null;
    emotion: string | null;
    ocr_text: string | null;
    text_with_cues: string | null;
  }>) {
    const list = bubblesByPanel.get(b.panel_id) ?? [];
    list.push({
      legacyId: b.legacy_id,
      type: b.type,
      speaker: b.speaker,
      emotion: b.emotion,
      text: b.text_with_cues ?? b.ocr_text ?? "",
    });
    bubblesByPanel.set(b.panel_id, list);
  }

  // 3. Cache page WebP buffers — many panels share a page
  const pageBufferCache = new Map<number, Buffer>();
  const getPageBuffer = async (pageNumber: number): Promise<Buffer> => {
    let buf = pageBufferCache.get(pageNumber);
    if (!buf) {
      const padded = String(pageNumber).padStart(2, "0");
      buf = await fs.readFile(join(PAGES_DIR, `page-${padded}.webp`));
      pageBufferCache.set(pageNumber, buf);
    }
    return buf;
  };

  const gemini = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  const limit = pLimit(2); // throttle Gemini concurrency
  let described = 0;
  let failed = 0;

  await Promise.all(
    todo.map((panel) =>
      limit(async () => {
        // Throttle: ~400ms between starts so we stay friendly to Flash quota
        await new Promise((r) => setTimeout(r, 400));
        try {
          const pageBuffer = await getPageBuffer(panel.page_number);
          const panelCrop = await cropPageToPanel(
            pageBuffer,
            panel.bounding_box,
          );
          const bubbles = bubblesByPanel.get(panel.id) ?? [];
          const isFullPagePanel = panel.source === "heuristic-fullpage";

          const result = await describeSinglePanel({
            gemini,
            geminiModel: GEMINI_MEDIUM,
            panelCropJpeg: panelCrop,
            bubbles,
            isFullPagePanel,
          });

          const primarySpeaker =
            bubbles.length > 0 ? mostCommonSpeaker(bubbles) : null;

          const { error: uErr } = await supabaseAdmin
            .from("panels")
            .update({
              cinematic_description: result.cinematicDescription,
              effect_tags: result.effectTags,
              audio_tags: result.audioTags,
              primary_speaker: primarySpeaker,
              updated_at: new Date().toISOString(),
            })
            .eq("id", panel.id);
          if (uErr) {
            failed++;
            console.warn(`   ⚠ ${panel.panel_id}: ${uErr.message}`);
            return;
          }
          described++;
          console.log(
            `   ✓ ${panel.panel_id} → ${result.effectTags.length} fx, ${result.audioTags.sfx.length} sfx, mood=${result.audioTags.music_mood}`,
          );
        } catch (e) {
          failed++;
          console.warn(`   ⚠ ${panel.panel_id}: ${(e as Error).message}`);
        }
      }),
    ),
  );

  console.log(
    `\n   ✓ ${described} panel(s) described${failed > 0 ? `, ${failed} failed` : ""}\n`,
  );
}

function mostCommonSpeaker(bubbles: PanelBubbleSummary[]): string | null {
  const counts = new Map<string, number>();
  for (const b of bubbles) {
    if (!b.speaker) continue;
    counts.set(b.speaker, (counts.get(b.speaker) ?? 0) + 1);
  }
  let best: string | null = null;
  let max = 0;
  for (const [name, n] of counts) {
    if (n > max) {
      max = n;
      best = name;
    }
  }
  return best;
}

// ─── Step: direct-panels (motion-comic-plus, legacy single-pass) ─────────────

async function directPanels(
  book: string,
  issue: string,
  force: boolean,
): Promise<void> {
  const ISSUE_DIR = join(PROJECT_ROOT, "assets", "comics", book, issue);
  const BUBBLES_PATH = join(ISSUE_DIR, "bubbles.json");
  const TIMESTAMPS_PATH = join(ISSUE_DIR, "audio-timestamps.json");
  const PAGES_DIR = join(ISSUE_DIR, "pages-webp");
  const GEMINI_CONTEXT_DIR = join(ISSUE_DIR, "data", "gemini-context");

  const EPISODE_DIR = join(PROJECT_ROOT, "assets", "episodes", book, issue);
  const PANEL_JSON_PATH = join(EPISODE_DIR, "panel-direction.json");

  if (!force && (await fs.pathExists(PANEL_JSON_PATH))) {
    console.log(
      `   ⏭  panel-direction.json already exists at ${PANEL_JSON_PATH} — re-run with --force to regenerate.`,
    );
    return;
  }

  for (const p of [BUBBLES_PATH, TIMESTAMPS_PATH, PAGES_DIR]) {
    if (!(await fs.pathExists(p))) {
      console.error(`❌ Missing ${p}`);
      process.exit(1);
    }
  }

  const bubblesByPage = (await fs.readJson(BUBBLES_PATH)) as Record<
    string,
    BubbleManifestEntry[]
  >;
  const audioTimestamps = (await fs.readJson(TIMESTAMPS_PATH)) as Record<
    string,
    PanelAudioTimestamp
  >;

  const pageFiles = (await fs.readdir(PAGES_DIR))
    .filter((f) => /^page-\d+\.webp$/i.test(f))
    .sort();

  const gemini = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

  console.log(
    `\n   🎬 Directing ${pageFiles.length} page(s) with ${GEMINI_MEDIUM}...\n`,
  );

  const pages: Awaited<ReturnType<typeof directPagePanels>>[] = [];
  let prevSummary: string | null = null;
  let analyzed = 0;
  let skipped = 0;

  for (const filename of pageFiles) {
    const m = /^page-(\d+)\.webp$/i.exec(filename);
    if (!m) continue;
    const pageNumber = parseInt(m[1]!, 10);
    const pagePadded = String(pageNumber).padStart(2, "0");
    const pageKey = `page-${pagePadded}.jpg`;
    process.stdout.write(
      `   [${(analyzed + skipped + 1).toString().padStart(3, " ")}/${pageFiles.length}] page-${pagePadded}... `,
    );

    try {
      const buffer = await fs.readFile(join(PAGES_DIR, filename));
      const manifest = (bubblesByPage[pageKey] ?? []) as BubbleManifestEntry[];

      // Pull cached aiReasoning for this page if it exists
      const ctxPath = join(
        GEMINI_CONTEXT_DIR,
        `page-${pagePadded}-gemini-context.json`,
      );
      let cachedReasoning: Array<Record<string, unknown>> = [];
      if (await fs.pathExists(ctxPath)) {
        cachedReasoning = (await fs.readJson(ctxPath)) as Array<
          Record<string, unknown>
        >;
      }

      const result = await directPagePanels({
        gemini,
        geminiModel: GEMINI_MEDIUM,
        pageNumber,
        pageImageBuffer: buffer,
        bubbleManifest: manifest,
        cachedReasoning: cachedReasoning as Parameters<
          typeof directPagePanels
        >[0]["cachedReasoning"],
        audioTimestamps,
        previousPageSummary: prevSummary,
        isFirstPage: analyzed === 0 && skipped === 0,
      });
      pages.push(result);
      prevSummary = result.settingSummary || prevSummary;
      analyzed++;
      console.log(
        `✓ ${result.panels.length} panel(s)${result.isNewScene ? " · new scene" : ""}`,
      );
    } catch (err) {
      skipped++;
      console.log(`⚠ ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  if (pages.length === 0) {
    console.error("\n❌ No pages directed successfully — aborting.");
    process.exit(1);
  }

  const direction: PanelDirection = {
    bookId: book,
    issueId: issue,
    generatedAt: new Date().toISOString(),
    pages,
  };

  await fs.ensureDir(EPISODE_DIR);
  await fs.writeJson(PANEL_JSON_PATH, direction, { spaces: 2 });
  console.log(`\n   💾 Wrote ${PANEL_JSON_PATH}`);

  // ── Persist to DB ─────────────────────────────────────────────────────────
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    console.log(
      "   ⚠ Supabase env vars not set — skipping DB sync. JSON file is the only artifact.",
    );
    return;
  }

  console.log("   📦 Syncing panels to DB...");
  let panelsInserted = 0;
  let bubblesAssigned = 0;

  for (const page of pages) {
    for (const panel of page.panels) {
      const { data: row, error } = await supabaseAdmin
        .from("panels")
        .upsert(
          {
            book_id: book,
            issue_id: issue,
            page_number: panel.pageNumber,
            panel_id: panel.panelId,
            sort_order: panel.sortOrder,
            bounding_box: panel.boundingBox,
            cinematic_description: panel.cinematicDescription,
            effect_tags: panel.effectTags,
            audio_tags: panel.audioTags,
            primary_speaker: panel.primarySpeaker,
            estimated_duration_seconds: panel.estimatedDurationSeconds,
            is_new_scene: panel.isNewScene,
            source: "gemini",
            updated_at: new Date().toISOString(),
          },
          { onConflict: "book_id,issue_id,panel_id" },
        )
        .select("id")
        .single();

      if (error) {
        console.warn(`     ⚠ panel ${panel.panelId}: ${error.message}`);
        continue;
      }
      const panelUuid = (row as { id?: string })?.id;
      if (!panelUuid) continue;
      panelsInserted++;

      // Assign bubbles to this panel via legacy_id
      if (panel.bubbleIds.length > 0) {
        const { error: bErr } = await supabaseAdmin
          .from("bubbles")
          .update({ panel_id: panelUuid })
          .eq("book_id", book)
          .eq("issue_id", issue)
          .in("legacy_id", panel.bubbleIds);
        if (bErr) {
          console.warn(
            `     ⚠ bubble assignment ${panel.panelId}: ${bErr.message}`,
          );
        } else {
          bubblesAssigned += panel.bubbleIds.length;
        }
      }
    }
  }

  console.log(
    `   ✓ ${panelsInserted} panel(s) upserted, ${bubblesAssigned} bubble(s) reassigned\n`,
  );
}

// ─── Step: plan-shots ─────────────────────────────────────────────────────────

async function planShots(
  book: string,
  issue: string,
  force: boolean,
): Promise<void> {
  const ISSUE_DIR = join(PROJECT_ROOT, "assets", "comics", book, issue);
  const BUBBLES_PATH = join(ISSUE_DIR, "bubbles.json");
  const TIMESTAMPS_PATH = join(ISSUE_DIR, "audio-timestamps.json");
  const PAGES_DIR = join(ISSUE_DIR, "pages-webp");

  const EPISODE_DIR = join(PROJECT_ROOT, "assets", "episodes", book, issue);
  const SHOT_PLAN_PATH = join(EPISODE_DIR, "shot-plan.json");

  if (!force && (await fs.pathExists(SHOT_PLAN_PATH))) {
    console.log(
      `   ⏭  shot-plan.json already exists at ${SHOT_PLAN_PATH} — re-run with --force to regenerate.\n   Edit the file by hand if you want adjustments before phases 3–4.`,
    );
    return;
  }

  if (!(await fs.pathExists(BUBBLES_PATH))) {
    console.error(`❌ Missing ${BUBBLES_PATH}`);
    console.error("   Run the comic ingest pipeline first.");
    process.exit(1);
  }
  if (!(await fs.pathExists(TIMESTAMPS_PATH))) {
    console.error(`❌ Missing ${TIMESTAMPS_PATH}`);
    console.error(
      "   Audio durations are required to estimate shot lengths. Run generate-audio first.",
    );
    process.exit(1);
  }
  if (!(await fs.pathExists(PAGES_DIR))) {
    console.error(`❌ Missing ${PAGES_DIR}`);
    process.exit(1);
  }

  const bubblesByPage = (await fs.readJson(BUBBLES_PATH)) as Record<
    string,
    BubbleInput[]
  >;
  const audioTimestamps = (await fs.readJson(TIMESTAMPS_PATH)) as Record<
    string,
    AudioTimestamp
  >;

  const gemini = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

  // ── Per-page Gemini Vision pass ──────────────────────────────────────────
  // Iterate page WebPs in order, hand each to analyzePage. Soft-fail per
  // page so a single Gemini hiccup doesn't drop the whole plan.
  const pageFiles = (await fs.readdir(PAGES_DIR))
    .filter((f) => /^page-\d+\.webp$/i.test(f))
    .sort();

  if (pageFiles.length === 0) {
    console.error(`❌ No page WebPs found in ${PAGES_DIR}`);
    process.exit(1);
  }

  console.log(
    `   📄 Analyzing ${pageFiles.length} page(s) with ${GEMINI_MEDIUM}...\n`,
  );

  const pageAnalyses = new Map<
    number,
    Awaited<ReturnType<typeof analyzePage>>
  >();
  let analyzed = 0;
  let skipped = 0;
  for (const filename of pageFiles) {
    const m = /^page-(\d+)\.webp$/i.exec(filename);
    if (!m) continue;
    const pageNumber = parseInt(m[1]!, 10);
    process.stdout.write(
      `   [${(analyzed + skipped + 1).toString().padStart(3, " ")}/${pageFiles.length}] page-${String(pageNumber).padStart(2, "0")}... `,
    );
    try {
      const buffer = await fs.readFile(join(PAGES_DIR, filename));
      const analysis = await analyzePage(
        gemini,
        buffer,
        pageNumber,
        analyzed === 0 && skipped === 0,
        GEMINI_MEDIUM,
      );
      pageAnalyses.set(pageNumber, analysis);
      analyzed++;
      console.log(
        `✓ ${analysis.panelCount} panel(s)${analysis.newSceneFromPreviousPage ? " · new scene" : ""}`,
      );
    } catch (err) {
      skipped++;
      console.log(`⚠ ${err instanceof Error ? err.message : String(err)}`);
    }
    // Light throttle so we don't burn through Flash tier in a burst
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  if (pageAnalyses.size === 0) {
    console.error("❌ No pages analyzed successfully — aborting");
    process.exit(1);
  }
  if (skipped > 0) {
    console.log(
      `   ⚠ ${skipped} page(s) skipped — shot plan will omit them. Inspect logs and re-run --force when fixed.`,
    );
  }

  // ── Build shots ──────────────────────────────────────────────────────────
  const shots = buildShots({
    bookId: book,
    issueId: issue,
    bubblesByPage,
    audioTimestamps,
    pageAnalyses,
  });

  const totalDur = shots.reduce(
    (acc, s) => acc + s.estimatedDurationSeconds,
    0,
  );
  const plan: ShotPlan = {
    bookId: book,
    issueId: issue,
    generatedAt: new Date().toISOString(),
    totalShots: shots.length,
    estimatedDurationSeconds: Math.round(totalDur * 10) / 10,
    shots,
  };

  await fs.ensureDir(EPISODE_DIR);
  await fs.writeJson(SHOT_PLAN_PATH, plan, { spaces: 2 });
  console.log(`\n   💾 Wrote ${SHOT_PLAN_PATH}`);

  // ── Review gate ──────────────────────────────────────────────────────────
  printShotTable(plan);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await new Promise<string>((resolve) =>
    rl.question("\nProceed with this plan? [Y/n] ", resolve),
  );
  rl.close();

  if (answer.trim().toLowerCase() === "n") {
    console.log(
      `\n   Pausing. Edit ${SHOT_PLAN_PATH} and re-run --only-step plan-shots --force when ready.`,
    );
    process.exit(2);
  }

  // If the user edited the file before answering, re-read from disk so the
  // checkpoint reflects what they actually approved.
  const finalPlan = (await fs.readJson(SHOT_PLAN_PATH)) as ShotPlan;
  console.log(
    `\n   ✓ Approved ${finalPlan.totalShots} shot(s) for production.\n`,
  );
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
    "detect-panels": () => detectPanels(book, issue, force),
    "describe-panels": () => describePanels(book, issue, force),
    "plan-shots": () => planShots(book, issue, force),
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

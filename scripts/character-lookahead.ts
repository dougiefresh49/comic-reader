#!/usr/bin/env node

/**
 * Pipeline step: character-lookahead
 *
 * Identifies every character in an issue by:
 *   1. Extracting face crops from SAM3 segmentation data
 *   2. Embedding each crop with CLIP (Roboflow workflow)
 *   3. Clustering embeddings with DBSCAN
 *   4. Identifying each cluster via Gemini
 *   5. Persisting to panel_character_detections + bubbles.character_id
 *
 * Runs after extract-foreground-masks, before get-context.
 */

import fs from "fs-extra";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";
import { supabase } from "./lib/supabase.js";
import { extractFaceCrops } from "./utils/face-extraction.js";
import { embedFaceCrops } from "./utils/clip-embeddings.js";
import { dbscan, distanceStats } from "./utils/clustering.js";
import { identifyClusters } from "./utils/character-identifier.js";
import { loadBookConfig, loadRoster } from "./utils/roster.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

function parseArgs(): { book: string; issue: string; overwrite: boolean } {
  const argv = process.argv.slice(2);
  let book = process.env.COMIC_BOOK ?? "";
  let issue = process.env.COMIC_ISSUE ?? "";
  let overwrite = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a.startsWith("--book=")) book = a.split("=")[1]?.trim() ?? book;
    else if (a === "--book") book = argv[i + 1]?.trim() ?? book;
    else if (a.startsWith("--issue=")) {
      const v = a.split("=")[1]?.trim() ?? "";
      issue = v.startsWith("issue-") ? v : `issue-${v}`;
    } else if (a === "--issue") {
      const v = argv[i + 1]?.trim() ?? "";
      issue = v.startsWith("issue-") ? v : `issue-${v}`;
    } else if (a === "--overwrite") overwrite = true;
  }
  if (!book || !issue) {
    console.error("❌ --book and --issue are required");
    process.exit(1);
  }
  return { book, issue, overwrite };
}

async function getIssueDbIds(
  bookSlug: string,
  issueSlug: string,
): Promise<{
  bookId: string;
  issueId: string;
  wikiAppearances: string | null;
} | null> {
  const { data: issueRow } = await supabase
    .from("issues")
    .select("id, book_id, wiki_appearances")
    .eq("book_id", bookSlug)
    .eq("slug", issueSlug)
    .single();

  if (!issueRow) {
    const { data: byBook } = await supabase
      .from("issues")
      .select("id, book_id, wiki_appearances")
      .eq("book_id", bookSlug)
      .limit(10);

    const match = byBook?.find((r) => {
      const num = issueSlug.replace("issue-", "");
      return String(r.id).includes(num) || String(r.book_id) === bookSlug;
    });
    if (match) {
      return {
        bookId: match.book_id as string,
        issueId: match.id as string,
        wikiAppearances: (match.wiki_appearances as string) ?? null,
      };
    }
    return null;
  }

  return {
    bookId: issueRow.book_id as string,
    issueId: issueRow.id as string,
    wikiAppearances: (issueRow.wiki_appearances as string) ?? null,
  };
}

async function getPanelsByPage(
  bookId: string,
  issueId: string,
): Promise<
  Map<
    number,
    Array<{
      id: string;
      panel_id: string;
      page_number: number;
      sort_order: number;
    }>
  >
> {
  const { data } = await supabase
    .from("panels")
    .select("id, panel_id, page_number, sort_order")
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .order("page_number")
    .order("sort_order");

  const map = new Map<
    number,
    Array<{
      id: string;
      panel_id: string;
      page_number: number;
      sort_order: number;
    }>
  >();
  for (const row of data ?? []) {
    const pn = row.page_number as number;
    if (!map.has(pn)) map.set(pn, []);
    map.get(pn)!.push(
      row as {
        id: string;
        panel_id: string;
        page_number: number;
        sort_order: number;
      },
    );
  }
  return map;
}

async function ensureCharacterExists(characterName: string): Promise<string> {
  const id = characterName.toLowerCase().replace(/\s+/g, "-");
  const { data: existing } = await supabase
    .from("characters")
    .select("id")
    .eq("id", id)
    .single();

  if (existing) return id;

  const { error } = await supabase.from("characters").insert({
    id,
    aliases: [characterName],
  });

  if (error) {
    if (error.code === "23505") return id;
    console.warn(`   ⚠ Failed to create character ${id}: ${error.message}`);
  }

  return id;
}

async function main() {
  const { book, issue, overwrite } = parseArgs();
  const BOOK_DIR = join(PROJECT_ROOT, "assets", "comics", book);
  const ISSUE_DIR = join(BOOK_DIR, issue);
  const SAM3_DIR = join(ISSUE_DIR, "data", "sam3");
  const WEBP_DIR = join(ISSUE_DIR, "pages-webp");
  const LOOKAHEAD_DIR = join(ISSUE_DIR, "data", "character-lookahead");
  const CACHE_PATH = join(LOOKAHEAD_DIR, "results.json");

  if (!overwrite && (await fs.pathExists(CACHE_PATH))) {
    console.log(
      `\n✅ character-lookahead already complete for ${book}/${issue} (use --overwrite to rerun)\n`,
    );
    return;
  }

  if (!(await fs.pathExists(SAM3_DIR))) {
    console.error(
      `❌ SAM3 sidecars not found at ${SAM3_DIR} — run roboflow-page-analyze first.`,
    );
    process.exit(1);
  }
  if (!(await fs.pathExists(WEBP_DIR))) {
    console.error(
      `❌ WebP pages not found at ${WEBP_DIR} — run convert-pages-to-webp first.`,
    );
    process.exit(1);
  }

  await fs.ensureDir(LOOKAHEAD_DIR);

  console.log(`\n🔍 Character lookahead for ${book}/${issue}\n`);

  // ── Step 1: Extract face crops ─────────────────────────────────────────
  console.log("📸 Step 1: Extracting face crops from SAM3 data...\n");
  const crops = await extractFaceCrops(SAM3_DIR, WEBP_DIR);
  console.log(`\n   ${crops.length} face crops extracted\n`);

  if (crops.length === 0) {
    console.log("   No face crops found — skipping lookahead.\n");
    await fs.writeJSON(
      CACHE_PATH,
      { clusters: [], identifications: [], cropCount: 0 },
      { spaces: 2 },
    );
    return;
  }

  // ── Step 2: CLIP embeddings ────────────────────────────────────────────
  console.log("🧠 Step 2: Generating CLIP embeddings...\n");
  const apiKey = process.env.ROBOFLOW_API_KEY;
  if (!apiKey) {
    console.error("❌ ROBOFLOW_API_KEY is required for CLIP embeddings");
    process.exit(1);
  }

  const embeddings = await embedFaceCrops(
    crops.map((c) => c.imageBuffer),
    apiKey,
    { concurrency: 3, delayMs: 200 },
  );

  const validCount = embeddings.filter((e) => e.length > 0).length;
  console.log(`\n   ${validCount}/${crops.length} embeddings generated\n`);

  // ── Step 3: Cluster ────────────────────────────────────────────────────
  console.log("🔗 Step 3: Clustering face embeddings (DBSCAN)...\n");

  const validIndices: number[] = [];
  const validEmbeddings: number[][] = [];
  for (let i = 0; i < embeddings.length; i++) {
    if (embeddings[i]!.length > 0) {
      validIndices.push(i);
      validEmbeddings.push(embeddings[i]!);
    }
  }

  const stats = distanceStats(validEmbeddings);
  console.log(
    `   Distance stats: min=${stats.min.toFixed(4)} p10=${stats.p10.toFixed(4)} p25=${stats.p25.toFixed(4)} median=${stats.median.toFixed(4)} p75=${stats.p75.toFixed(4)} p90=${stats.p90.toFixed(4)} max=${stats.max.toFixed(4)}`,
  );

  const eps = stats.p10 > 0 ? stats.p10 * 0.85 : 0.08;
  console.log(`   Using eps=${eps.toFixed(4)} (85% of p10)\n`);

  const { clusters: rawClusters, noise } = dbscan(validEmbeddings, eps, 2);

  const clusters = rawClusters.map((c) => ({
    ...c,
    memberIndices: c.memberIndices.map((i) => validIndices[i]!),
  }));

  console.log(`   ${clusters.length} clusters, ${noise.length} noise points\n`);
  for (const c of clusters) {
    const pages = new Set(c.memberIndices.map((i) => crops[i]!.pageNumber));
    console.log(
      `   cluster ${c.id}: ${c.memberIndices.length} faces across pages [${[...pages].sort((a, b) => a - b).join(", ")}]`,
    );
  }

  // ── Step 4: Identify clusters ──────────────────────────────────────────
  console.log("\n🎭 Step 4: Identifying characters via Gemini...\n");

  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    console.error("❌ GEMINI_API_KEY is required");
    process.exit(1);
  }
  const gemini = new GoogleGenAI({ apiKey: geminiKey });

  const bookConfig = await loadBookConfig(BOOK_DIR);
  const roster = await loadRoster(BOOK_DIR);

  const dbInfo = await getIssueDbIds(book, issue);
  const wikiAppearances = dbInfo?.wikiAppearances ?? null;

  const identifications = await identifyClusters(gemini, clusters, crops, {
    bookTitle: bookConfig?.title ?? book,
    characterContext:
      bookConfig?.characterContext ??
      "Identify characters by their proper canonical names.",
    roster,
    wikiAppearances,
  });

  // ── Step 5: Persist to DB ──────────────────────────────────────────────
  console.log("\n💾 Step 5: Persisting results...\n");

  if (!dbInfo) {
    console.warn(
      "   ⚠ Could not find issue in DB — saving results to disk only.",
    );
    await fs.writeJSON(
      CACHE_PATH,
      {
        cropCount: crops.length,
        clusters: clusters.map((c) => ({
          id: c.id,
          memberCount: c.memberIndices.length,
        })),
        identifications,
      },
      { spaces: 2 },
    );
    console.log(`\n✅ Results saved to ${CACHE_PATH}\n`);
    return;
  }

  const { bookId, issueId } = dbInfo;
  const panelsByPage = await getPanelsByPage(bookId, issueId);

  if (overwrite) {
    await supabase
      .from("panel_character_detections")
      .delete()
      .eq("panel_id", issueId);

    const allPanelIds: string[] = [];
    for (const panels of panelsByPage.values()) {
      for (const p of panels) allPanelIds.push(p.id);
    }
    if (allPanelIds.length > 0) {
      await supabase
        .from("panel_character_detections")
        .delete()
        .in("panel_id", allPanelIds);
    }
  }

  let insertedCount = 0;

  for (const identification of identifications) {
    const cluster = clusters.find((c) => c.id === identification.clusterId);
    if (!cluster) continue;

    const characterId = await ensureCharacterExists(
      identification.characterName,
    );

    const rows: Array<{
      character_id: string;
      panel_id: string;
      face_bbox: object;
      cluster_id: number;
      identification_confidence: number;
    }> = [];

    for (const cropIdx of cluster.memberIndices) {
      const crop = crops[cropIdx]!;
      const pagePanels = panelsByPage.get(crop.pageNumber);
      if (!pagePanels) continue;

      const panel = pagePanels[crop.panelIndex];
      if (!panel) continue;

      rows.push({
        character_id: characterId,
        panel_id: panel.id,
        face_bbox: crop.bboxPanelLocal,
        cluster_id: cluster.id,
        identification_confidence: identification.confidence,
      });
    }

    if (rows.length > 0) {
      const { error } = await supabase
        .from("panel_character_detections")
        .insert(rows);
      if (error) {
        console.warn(
          `   ⚠ Failed to insert detections for ${identification.characterName}: ${error.message}`,
        );
      } else {
        insertedCount += rows.length;
      }
    }
  }

  console.log(`   ${insertedCount} panel_character_detections rows inserted`);

  // ── Step 6: Assign bubbles by geometry ─────────────────────────────────
  console.log("\n📍 Step 6: Assigning bubbles by face proximity...\n");

  const { data: bubbles } = await supabase
    .from("bubbles")
    .select("id, page_number, style, panel_id")
    .eq("book_id", bookId)
    .eq("issue_id", issueId);

  let assignedCount = 0;

  for (const bubble of bubbles ?? []) {
    if (!bubble.panel_id || !bubble.style) continue;

    const { data: detections } = await supabase
      .from("panel_character_detections")
      .select("character_id, face_bbox")
      .eq("panel_id", bubble.panel_id as string);

    if (!detections || detections.length === 0) continue;

    const bubbleStyle = bubble.style as {
      left?: string;
      top?: string;
      width?: string;
      height?: string;
    };
    const bubbleLeft = parseFloat(bubbleStyle.left ?? "50") / 100;
    const bubbleTop = parseFloat(bubbleStyle.top ?? "0") / 100;
    const bubbleW = parseFloat(bubbleStyle.width ?? "10") / 100;
    const bubbleCx = bubbleLeft + bubbleW / 2;
    const bubbleTailY = bubbleTop;

    let closestCharId: string | null = null;
    let closestDist = Infinity;

    for (const det of detections) {
      const fb = det.face_bbox as {
        x: number;
        y: number;
        w: number;
        h: number;
      };
      const faceCx = fb.x + fb.w / 2;
      const faceCy = fb.y + fb.h / 2;
      const dist = Math.hypot(faceCx - bubbleCx, faceCy - bubbleTailY);
      if (dist < closestDist) {
        closestDist = dist;
        closestCharId = det.character_id as string;
      }
    }

    if (closestCharId) {
      const { error } = await supabase
        .from("bubbles")
        .update({ character_id: closestCharId })
        .eq("id", bubble.id as string);
      if (!error) assignedCount++;
    }
  }

  console.log(`   ${assignedCount} bubbles assigned character_id by proximity`);

  // ── Save results cache ─────────────────────────────────────────────────
  await fs.writeJSON(
    CACHE_PATH,
    {
      cropCount: crops.length,
      embeddingCount: validCount,
      clusterCount: clusters.length,
      noiseCount: noise.length,
      clusters: clusters.map((c) => ({
        id: c.id,
        memberCount: c.memberIndices.length,
      })),
      identifications,
      insertedDetections: insertedCount,
      assignedBubbles: assignedCount,
    },
    { spaces: 2 },
  );

  console.log(`\n✅ Character lookahead complete for ${book}/${issue}`);
  console.log(
    `   ${clusters.length} characters identified, ${insertedCount} detections, ${assignedCount} bubbles assigned\n`,
  );
}

main().catch((err) => {
  console.error("❌ character-lookahead:", err);
  process.exit(1);
});

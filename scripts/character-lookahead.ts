#!/usr/bin/env node

/**
 * Pipeline step: character-lookahead (v2 — incremental Gemini matching)
 *
 * Identifies every character in an issue by:
 *   1. Extracting face crops from SAM3 segmentation data page-by-page
 *   2. Matching each face against existing clusters via Gemini Flash
 *   3. Growing clusters incrementally — no batch CLIP or DBSCAN needed
 *   4. Persisting to panel_character_detections + bubbles.character_id
 *
 * Runs after extract-foreground-masks, before get-context.
 */

import fs from "fs-extra";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";
import { supabase } from "./lib/supabase.js";
import { extractFaceCropsForPage } from "./utils/face-extraction.js";
import {
  identifySingleFace,
  type CharacterCluster,
} from "./utils/face-matcher.js";
import { loadRoster } from "./utils/roster.js";
import { glob } from "glob";

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

function buildKnownCharacterList(
  roster: Record<string, { canonicalName: string; aliases: string[] }>,
  wikiAppearances: string | null,
): string[] {
  const names = new Set<string>();
  for (const entry of Object.values(roster)) {
    names.add(entry.canonicalName);
  }
  if (wikiAppearances) {
    try {
      const parsed = JSON.parse(wikiAppearances) as Array<{
        name: string;
        qualifier?: string;
      }>;
      for (const a of parsed) {
        if (a.name) names.add(a.name);
      }
    } catch {
      // wiki_appearances might be plain text
      if (typeof wikiAppearances === "string") {
        for (const line of wikiAppearances.split("\n")) {
          const trimmed = line.replace(/^[-*•]\s*/, "").trim();
          if (trimmed) names.add(trimmed);
        }
      }
    }
  }
  return [...names].sort();
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

  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    console.error("❌ GEMINI_API_KEY is required");
    process.exit(1);
  }
  const gemini = new GoogleGenAI({ apiKey: geminiKey });

  const roster = await loadRoster(BOOK_DIR);
  const dbInfo = await getIssueDbIds(book, issue);
  const wikiAppearances = dbInfo?.wikiAppearances ?? null;
  const knownCharacters = buildKnownCharacterList(roster, wikiAppearances);

  console.log(`\n🔍 Character lookahead for ${book}/${issue}\n`);
  if (knownCharacters.length > 0) {
    console.log(`   Known characters: ${knownCharacters.join(", ")}\n`);
  }

  // ── Incremental page-by-page scan ──────────────────────────────────────
  const sidecars = await glob("page-*.json", { cwd: SAM3_DIR });
  sidecars.sort();

  const clusters: CharacterCluster[] = [];
  let nextClusterId = 0;
  let totalCrops = 0;
  const allAssignments: Array<{
    pageNumber: number;
    panelIndex: number;
    clusterId: number;
    bboxPanelLocal: { x: number; y: number; w: number; h: number };
  }> = [];

  for (const filename of sidecars) {
    const pageNum = parseInt(
      filename.replace("page-", "").replace(".json", ""),
      10,
    );
    const padded = String(pageNum).padStart(2, "0");

    const crops = await extractFaceCropsForPage(SAM3_DIR, WEBP_DIR, pageNum);
    if (crops.length === 0) continue;

    totalCrops += crops.length;
    console.log(`   page-${padded}: ${crops.length} faces`);

    // Identify all faces on this page concurrently
    const identifications = await Promise.all(
      crops.map((face) => identifySingleFace(gemini, face, knownCharacters)),
    );

    for (let i = 0; i < crops.length; i++) {
      const face = crops[i]!;
      const { characterName, confidence } = identifications[i]!;

      // Merge into existing cluster by name, or create a new one
      const existing = characterName
        ? clusters.find(
            (c) =>
              c.characterName?.toLowerCase() === characterName.toLowerCase(),
          )
        : null;

      if (existing) {
        existing.memberCount++;
        if (confidence > existing.confidence) {
          existing.confidence = confidence;
          existing.exemplar = face;
        }
        allAssignments.push({
          pageNumber: face.pageNumber,
          panelIndex: face.panelIndex,
          clusterId: existing.id,
          bboxPanelLocal: face.bboxPanelLocal,
        });
      } else {
        const id = nextClusterId++;
        clusters.push({
          id,
          characterName,
          confidence,
          exemplar: face,
          memberCount: 1,
        });
        allAssignments.push({
          pageNumber: face.pageNumber,
          panelIndex: face.panelIndex,
          clusterId: id,
          bboxPanelLocal: face.bboxPanelLocal,
        });
        console.log(
          `     → new cluster ${id}: ${characterName ?? "unknown"} (${(confidence * 100).toFixed(0)}%)`,
        );
      }
    }
  }

  console.log(
    `\n📊 Summary: ${totalCrops} faces → ${clusters.length} clusters\n`,
  );
  for (const c of clusters) {
    console.log(
      `   cluster ${c.id}: ${c.characterName ?? "unknown"} — ${c.memberCount} faces (${(c.confidence * 100).toFixed(0)}%)`,
    );
  }

  // ── Persist to DB ──────────────────────────────────────────────────────
  console.log("\n💾 Persisting results...\n");

  if (!dbInfo) {
    console.warn(
      "   ⚠ Could not find issue in DB — saving results to disk only.",
    );
    await fs.writeJSON(
      CACHE_PATH,
      {
        cropCount: totalCrops,
        clusters: clusters.map((c) => ({
          id: c.id,
          characterName: c.characterName,
          memberCount: c.memberCount,
          confidence: c.confidence,
        })),
      },
      { spaces: 2 },
    );
    console.log(`\n✅ Results saved to ${CACHE_PATH}\n`);
    return;
  }

  const { bookId, issueId } = dbInfo;
  const panelsByPage = await getPanelsByPage(bookId, issueId);

  if (overwrite) {
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

  // Build character_id cache so we don't call ensureCharacterExists repeatedly
  const charIdCache = new Map<number, string>();
  for (const cluster of clusters) {
    if (!cluster.characterName) continue;
    const charId = await ensureCharacterExists(cluster.characterName);
    charIdCache.set(cluster.id, charId);
  }

  const detectionRows: Array<{
    character_id: string;
    panel_id: string;
    face_bbox: object;
    cluster_id: number;
    identification_confidence: number;
  }> = [];

  for (const assignment of allAssignments) {
    const charId = charIdCache.get(assignment.clusterId);
    if (!charId) continue;

    const pagePanels = panelsByPage.get(assignment.pageNumber);
    if (!pagePanels) continue;

    const panel = pagePanels[assignment.panelIndex];
    if (!panel) continue;

    const cluster = clusters.find((c) => c.id === assignment.clusterId);
    detectionRows.push({
      character_id: charId,
      panel_id: panel.id,
      face_bbox: assignment.bboxPanelLocal,
      cluster_id: assignment.clusterId,
      identification_confidence: cluster?.confidence ?? 0,
    });
  }

  // Batch insert in chunks of 100
  for (let i = 0; i < detectionRows.length; i += 100) {
    const chunk = detectionRows.slice(i, i + 100);
    const { error } = await supabase
      .from("panel_character_detections")
      .insert(chunk);
    if (error) {
      console.warn(`   ⚠ Insert batch failed: ${error.message}`);
    } else {
      insertedCount += chunk.length;
    }
  }

  console.log(`   ${insertedCount} panel_character_detections rows inserted`);

  // ── Assign bubbles by geometry ─────────────────────────────────────────
  console.log("\n📍 Assigning bubbles by face proximity...\n");

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
      cropCount: totalCrops,
      clusters: clusters.map((c) => ({
        id: c.id,
        characterName: c.characterName,
        memberCount: c.memberCount,
        confidence: c.confidence,
      })),
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

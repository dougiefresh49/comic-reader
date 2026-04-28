#!/usr/bin/env node
// Usage: pnpm migrate-to-db -- --book tmnt-mmpr-iii --issue 1
//        pnpm migrate-to-db -- --all
//
// Migrates local JSON files into Supabase. Idempotent — safe to re-run.
// Migration order respects FK constraints:
//   books → issues → pages → bubbles (builds legacyIdToUuid map)
//   → audio_timestamps → castlist → characters → character_appearances → aliases

import { createClient } from "@supabase/supabase-js";
import fs from "fs-extra";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");

// ── Supabase client ────────────────────────────────────────────────────────
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
});

// ── Arg parsing ────────────────────────────────────────────────────────────
function parseArgs(): { book?: string; issue?: string; all: boolean } {
  const args = process.argv.slice(2);
  const bookIdx = args.indexOf("--book");
  const issueIdx = args.indexOf("--issue");
  return {
    book: bookIdx >= 0 ? args[bookIdx + 1] : undefined,
    issue: issueIdx >= 0 ? args[issueIdx + 1] : undefined,
    all: args.includes("--all"),
  };
}

function pageNumFromKey(key: string): number {
  // handles "page-01.jpg", "page-01", "page-1"
  const match = key.match(/page-?0*(\d+)/i);
  return match ? parseInt(match[1]!, 10) : 0;
}

// ── Book-level config ──────────────────────────────────────────────────────
interface BookConfig {
  title: string;
  franchises?: string[];
}

async function migrateBook(bookId: string): Promise<void> {
  const bookDir = join(ROOT, "assets", "comics", bookId);
  const configPath = join(bookDir, "book-config.json");

  if (!fs.existsSync(configPath)) {
    console.error(`No book-config.json for ${bookId}`);
    return;
  }

  const config: BookConfig = fs.readJsonSync(configPath);
  const slug = bookId;

  console.log(`\n📚 Book: ${bookId}`);
  const { error } = await supabase
    .from("books")
    .upsert({ id: bookId, name: config.title, slug }, { onConflict: "id" });
  if (error) throw new Error(`books upsert: ${error.message}`);
  console.log(`  ✓ books row`);
}

// ── Issue ──────────────────────────────────────────────────────────────────
async function migrateIssue(bookId: string, issueDir: string): Promise<void> {
  const issueDirName = issueDir.split("/").pop()!;
  const issueId = issueDirName; // "issue-1"
  const issueNum = parseInt(issueId.replace(/\D/g, ""), 10);

  console.log(`\n  📖 Issue: ${issueId}`);

  // Count pages + bubbles for metadata
  const pagesPath = join(issueDir, "pages.json");
  const bubblesPath = join(issueDir, "bubbles.json");
  const audioTsPath = join(issueDir, "audio-timestamps.json");
  const castlistPath = join(issueDir, "castlist.json");

  const pagesData = fs.existsSync(pagesPath)
    ? (fs.readJsonSync(pagesPath) as Record<
        string,
        { width: number; height: number }
      >)
    : null;

  const bubblesData = fs.existsSync(bubblesPath)
    ? (fs.readJsonSync(bubblesPath) as Record<string, BubbleRaw[]>)
    : null;

  const pageCount = pagesData ? Object.keys(pagesData).length : 0;
  const bubbleCount = bubblesData
    ? Object.values(bubblesData).reduce((sum, arr) => sum + arr.length, 0)
    : 0;
  const audioCount = fs.existsSync(audioTsPath)
    ? Object.keys(fs.readJsonSync(audioTsPath) as object).length
    : 0;

  const { error: issueError } = await supabase.from("issues").upsert(
    {
      id: issueId,
      book_id: bookId,
      number: issueNum,
      name: `Issue ${issueNum}`,
      page_count: pageCount,
      bubble_count: bubbleCount,
      audio_count: audioCount,
      has_webp: fs.existsSync(join(issueDir, "pages-webp")),
      has_audio: fs.existsSync(join(issueDir, "audio")),
      has_timestamps: fs.existsSync(audioTsPath),
      status: audioCount > 0 ? "ready" : "processing",
    },
    { onConflict: "book_id,id" },
  );
  if (issueError) throw new Error(`issues upsert: ${issueError.message}`);
  console.log(
    `    ✓ issues row (${pageCount} pages, ${bubbleCount} bubbles, ${audioCount} timestamps)`,
  );

  // ── Pages ────────────────────────────────────────────────────────────────
  if (pagesData) {
    const pageRows = Object.entries(pagesData).map(([key, dims]) => ({
      book_id: bookId,
      issue_id: issueId,
      number: pageNumFromKey(key),
      width: dims.width,
      height: dims.height,
      storage_path: `${bookId}/${issueId}/page-${String(pageNumFromKey(key)).padStart(2, "0")}.webp`,
    }));

    const { error: pagesError } = await supabase
      .from("pages")
      .upsert(pageRows, { onConflict: "book_id,issue_id,number" });
    if (pagesError) throw new Error(`pages upsert: ${pagesError.message}`);
    console.log(`    ✓ pages rows (${pageRows.length})`);
  }

  // ── Bubbles ──────────────────────────────────────────────────────────────
  const legacyIdToUuid = new Map<string, string>();

  if (bubblesData) {
    let inserted = 0;
    let reused = 0;

    for (const [pageKey, bubbles] of Object.entries(bubblesData)) {
      const pageNumber = pageNumFromKey(pageKey);

      for (const [sortIndex, bubble] of bubbles.entries()) {
        const legacyId = bubble.id;

        // Check for existing row to preserve UUID on re-run
        const { data: existing } = await supabase
          .from("bubbles")
          .select("id")
          .eq("book_id", bookId)
          .eq("issue_id", issueId)
          .eq("legacy_id", legacyId)
          .maybeSingle();

        if (existing) {
          legacyIdToUuid.set(legacyId, existing.id);
          reused++;
          continue;
        }

        const row = {
          legacy_id: legacyId,
          book_id: bookId,
          issue_id: issueId,
          page_number: pageNumber,
          sort_order: sortIndex,
          ocr_text: bubble.ocr_text ?? null,
          text_with_cues: bubble.textWithCues ?? null,
          type: bubble.type ?? "SPEECH",
          speaker: bubble.speaker ?? null,
          emotion: bubble.emotion ?? null,
          character_type: bubble.characterType ?? null,
          side: bubble.side ?? null,
          voice_description: bubble.voiceDescription ?? null,
          ai_reasoning: bubble.aiReasoning ?? null,
          ignored: bubble.ignored ?? false,
          needs_audio: bubble.needsAudio ?? false,
          needs_ocr: bubble.needsOcr ?? false,
          box_2d: bubble.box_2d ?? null,
          style: bubble.style ?? null,
          // Preserve original filename — no re-upload needed
          audio_storage_path: `${legacyId}.mp3`,
        };

        const { data: inserted_row, error: bubbleError } = await supabase
          .from("bubbles")
          .insert(row)
          .select("id")
          .single();

        if (bubbleError) {
          console.warn(
            `    ⚠ bubble insert failed (${legacyId}): ${bubbleError.message}`,
          );
          continue;
        }

        legacyIdToUuid.set(legacyId, inserted_row.id);
        inserted++;
      }
    }

    console.log(`    ✓ bubbles (${inserted} inserted, ${reused} reused)`);
  }

  // ── Audio timestamps ─────────────────────────────────────────────────────
  if (fs.existsSync(audioTsPath) && legacyIdToUuid.size > 0) {
    const tsData = fs.readJsonSync(audioTsPath) as Record<
      string,
      AudioTimestampRaw
    >;
    const rows = [];
    let skipped = 0;

    for (const [legacyId, ts] of Object.entries(tsData)) {
      const uuid = legacyIdToUuid.get(legacyId);
      if (!uuid) {
        console.warn(
          `    ⚠ no bubble UUID for timestamp ${legacyId} — skipping`,
        );
        skipped++;
        continue;
      }
      rows.push({
        bubble_id: uuid,
        book_id: bookId,
        issue_id: issueId,
        alignment: ts.alignment ?? null,
        normalized_alignment: ts.normalizedAlignment ?? null,
      });
    }

    if (rows.length > 0) {
      const { error: tsError } = await supabase
        .from("audio_timestamps")
        .upsert(rows, { onConflict: "bubble_id" });
      if (tsError)
        throw new Error(`audio_timestamps upsert: ${tsError.message}`);
    }
    console.log(
      `    ✓ audio_timestamps (${rows.length} rows${skipped > 0 ? `, ${skipped} skipped` : ""})`,
    );
  }

  // ── Castlist ─────────────────────────────────────────────────────────────
  if (fs.existsSync(castlistPath)) {
    const castData = fs.readJsonSync(castlistPath) as Record<string, string>;
    const castRows = Object.entries(castData).map(([character, voiceId]) => ({
      book_id: bookId,
      issue_id: issueId,
      character,
      voice_id: voiceId,
    }));

    const { error: castError } = await supabase
      .from("castlist")
      .upsert(castRows, { onConflict: "book_id,issue_id,character" });
    if (castError) throw new Error(`castlist upsert: ${castError.message}`);
    console.log(`    ✓ castlist (${castRows.length} entries)`);
  }
}

// ── Character registry ─────────────────────────────────────────────────────
interface CharacterRegistryEntry {
  franchise?: string;
  aliases?: string[];
  appearances?: AppearanceRaw[];
}

interface AppearanceRaw {
  id: string;
  mediaTitle?: string | null;
  year?: number | null;
  voiceActor?: string | null;
  mediaType?: string | null;
  youtubeSearchTerms?: string[];
  notes?: string | null;
  voice?: {
    voiceId?: string;
    voiceType?: string;
    status?: string;
    createdAt?: string;
    voiceDescription?: string;
  };
}

async function migrateCharacters(): Promise<void> {
  const registryPath = join(ROOT, "data", "character-registry.json");
  if (!fs.existsSync(registryPath)) {
    console.log("\n  ⚠ No character-registry.json — skipping characters");
    return;
  }

  console.log("\n  👤 Characters");
  const registry = fs.readJsonSync(registryPath) as Record<
    string,
    CharacterRegistryEntry
  >;

  const charRows = Object.entries(registry).map(([name, entry]) => ({
    id: name,
    franchise: entry.franchise ?? null,
    aliases: entry.aliases ?? [],
  }));

  const { error: charError } = await supabase
    .from("characters")
    .upsert(charRows, { onConflict: "id" });
  if (charError) throw new Error(`characters upsert: ${charError.message}`);
  console.log(`    ✓ characters (${charRows.length})`);

  // Appearances
  const appearanceRows = [];
  for (const [characterId, entry] of Object.entries(registry)) {
    for (const app of entry.appearances ?? []) {
      appearanceRows.push({
        id: app.id,
        character_id: characterId,
        media_title: app.mediaTitle ?? null,
        year: app.year ?? null,
        voice_actor: app.voiceActor ?? null,
        media_type: app.mediaType ?? null,
        youtube_search_terms: app.youtubeSearchTerms ?? [],
        notes: app.notes ?? null,
        voice_id: app.voice?.voiceId ?? null,
        voice_type: app.voice?.voiceType ?? null,
        voice_status: app.voice?.status ?? null,
        voice_description: app.voice?.voiceDescription ?? null,
        voice_created_at: app.voice?.createdAt ?? null,
        voice_model_status: app.voice?.status === "ready" ? "ready" : "pending",
      });
    }
  }

  if (appearanceRows.length > 0) {
    const { error: appError } = await supabase
      .from("character_appearances")
      .upsert(appearanceRows, { onConflict: "id" });
    if (appError)
      throw new Error(`character_appearances upsert: ${appError.message}`);
  }
  console.log(`    ✓ character_appearances (${appearanceRows.length})`);
}

// ── Aliases ────────────────────────────────────────────────────────────────
async function migrateAliases(): Promise<void> {
  const aliasPath = join(ROOT, "data", "alias-map.json");
  if (!fs.existsSync(aliasPath)) {
    console.log("\n  ⚠ No alias-map.json — skipping aliases");
    return;
  }

  console.log("\n  🔤 Aliases");
  const aliasMap = fs.readJsonSync(aliasPath) as Record<string, string>;

  const rows = Object.entries(aliasMap).map(([alias, canonical]) => ({
    alias: alias.toLowerCase(),
    canonical,
    scope: "global" as const,
    scope_id: null,
  }));

  const { error } = await supabase
    .from("aliases")
    .upsert(rows, { onConflict: "alias,scope,scope_id" });
  if (error) throw new Error(`aliases upsert: ${error.message}`);
  console.log(`    ✓ aliases (${rows.length})`);
}

// ── Types ──────────────────────────────────────────────────────────────────
interface BubbleRaw {
  id: string;
  box_2d?: object;
  ocr_text?: string;
  type?: string;
  speaker?: string;
  emotion?: string;
  characterType?: string;
  side?: string;
  voiceDescription?: string;
  textWithCues?: string;
  aiReasoning?: string;
  style?: object;
  ignored?: boolean;
  needsAudio?: boolean;
  needsOcr?: boolean;
}

interface AudioTimestampRaw {
  alignment?: object;
  normalizedAlignment?: object;
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const { book, issue, all } = parseArgs();

  if (!all && !book) {
    console.error("Usage: pnpm migrate-to-db -- --book <name> --issue <n>");
    console.error("       pnpm migrate-to-db -- --all");
    process.exit(1);
  }

  const comicsDir = join(ROOT, "assets", "comics");

  // Collect (bookId, issueDir) pairs to process
  const targets: { bookId: string; issueDir: string | null }[] = [];

  if (all) {
    const books = fs
      .readdirSync(comicsDir)
      .filter((d) => fs.statSync(join(comicsDir, d)).isDirectory());
    for (const bookId of books) {
      targets.push({ bookId, issueDir: null });
    }
  } else {
    targets.push({ bookId: book!, issueDir: null });
  }

  for (const { bookId } of targets) {
    await migrateBook(bookId);

    const bookDir = join(comicsDir, bookId);
    const issueDirs = fs
      .readdirSync(bookDir)
      .filter(
        (d) =>
          d.startsWith("issue-") && fs.statSync(join(bookDir, d)).isDirectory(),
      )
      .map((d) => join(bookDir, d));

    const filteredDirs =
      issue && !all
        ? issueDirs.filter((d) => d.endsWith(`issue-${issue}`))
        : issueDirs;

    for (const dir of filteredDirs) {
      await migrateIssue(bookId, dir);
    }
  }

  // Global data (always migrated when running --all or per-book)
  await migrateCharacters();
  await migrateAliases();

  console.log("\n✅ Migration complete\n");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

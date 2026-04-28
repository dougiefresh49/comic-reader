#!/usr/bin/env node

/**
 * Copy necessary content files from assets to public directory
 *
 * Copies:
 * - WebP page images (from pages-webp/)
 * - Audio files (from audio/)
 * - JSON data files (bubbles.json, audio-timestamps.json, pages.json)
 * - Castlist (from root comic directory)
 *
 * Files are organized in public/comics/<book>/issue-x/ for Next.js serving
 *
 * STORAGE_MODE (env) or --mode: local (default) | supabase | both
 */

import fs from "fs-extra";
import pLimit from "p-limit";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

type StorageMode = "local" | "supabase" | "both";

function pageNumFromKey(key: string): number {
  const match = key.match(/page-?0*(\d+)/i);
  return match ? parseInt(match[1]!, 10) : 0;
}

interface BubbleJson {
  id: string;
  box_2d?: Record<string, unknown>;
  ocr_text?: string;
  type?: string;
  speaker?: string | null;
  emotion?: string;
  characterType?: string;
  side?: string;
  voiceDescription?: string;
  textWithCues?: string;
  aiReasoning?: string;
  style?: unknown;
  ignored?: boolean;
  needsAudio?: boolean;
  needsOcr?: boolean;
}

function bubbleToRow(
  bookId: string,
  issueId: string,
  pageNumber: number,
  sortOrder: number,
  bubble: BubbleJson,
  withInsertOnly: { audio_storage_path: string } | null,
) {
  const base = {
    legacy_id: bubble.id,
    book_id: bookId,
    issue_id: issueId,
    page_number: pageNumber,
    sort_order: sortOrder,
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
  };
  if (withInsertOnly) {
    return { ...base, ...withInsertOnly };
  }
  return base;
}

/**
 * Parse command-line arguments
 */
function parseArgs(): {
  book: string;
  issue: string;
  overwrite?: boolean;
  modeArg?: string;
} {
  const args = process.argv.slice(2);

  // Check for help flag
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage: npm run copy-to-public [options]

Options:
  --issue=N, --issue N        Issue number (e.g., --issue=1 for issue-1, default: issue-1)
  --overwrite                  Overwrite existing files in public directory
  --mode=local|supabase|both  Override STORAGE_MODE (default: env STORAGE_MODE or local)
  --help, -h                  Show this help message

Examples:
  npm run copy-to-public                    Copy files for issue-1
  npm run copy-to-public --issue=2         Copy files for issue-2
  npm run copy-to-public --overwrite       Overwrite existing files
`);
    process.exit(0);
  }

  let book = process.env.COMIC_BOOK ?? "tmnt-mmpr-iii";
  let issue = process.env.COMIC_ISSUE ?? "issue-1";
  let overwrite = false;
  let modeArg: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    if (arg.startsWith("--book=")) {
      book = arg.split("=")[1]?.trim() ?? book;
    }
    if (arg === "--book") {
      const nextArg = args[i + 1];
      if (nextArg) book = nextArg.trim();
    }
    if (arg.startsWith("--issue=")) {
      const issueNum = arg.split("=")[1]?.trim();
      if (issueNum) {
        issue = issueNum.startsWith("issue-") ? issueNum : `issue-${issueNum}`;
      }
    }
    if (arg === "--issue") {
      const nextArg = args[i + 1];
      if (nextArg) {
        const issueNum = nextArg.trim();
        issue = issueNum.startsWith("issue-") ? issueNum : `issue-${issueNum}`;
      }
    }
    if (arg === "--overwrite") {
      overwrite = true;
    }
    if (arg.startsWith("--mode=")) {
      modeArg = arg.split("=")[1]?.trim().toLowerCase();
    }
    if (arg === "--mode") {
      const next = args[i + 1];
      if (next) modeArg = next.trim().toLowerCase();
    }
  }

  return { book, issue, overwrite, modeArg };
}

function resolveStorageMode(modeArg?: string): StorageMode {
  const raw = (modeArg ?? process.env.STORAGE_MODE ?? "local").toLowerCase();
  if (raw === "supabase" || raw === "both" || raw === "local") return raw;
  return "local";
}

/**
 * Copy files from source to destination
 */
async function copyFiles(
  sourceDir: string,
  destDir: string,
  filePattern: string,
  description: string,
  overwrite: boolean,
): Promise<{ copied: number; skipped: number; errors: number }> {
  let copied = 0;
  let skipped = 0;
  let errors = 0;

  if (!(await fs.pathExists(sourceDir))) {
    console.log(`   ⚠️  ${description} directory not found: ${sourceDir}`);
    return { copied, skipped, errors };
  }

  await fs.ensureDir(destDir);

  const files = await fs.readdir(sourceDir);
  const matchingFiles = files.filter((file) => {
    if (filePattern.includes("*")) {
      const pattern = filePattern.replace("*", ".*");
      return new RegExp(pattern).test(file);
    }
    return file.endsWith(filePattern);
  });

  for (const file of matchingFiles) {
    const sourcePath = join(sourceDir, file);
    const destPath = join(destDir, file);

    try {
      // Check if file already exists
      if (!overwrite && (await fs.pathExists(destPath))) {
        skipped++;
        continue;
      }

      await fs.copy(sourcePath, destPath);
      copied++;
    } catch (error) {
      console.error(
        `      ❌ Error copying ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
      errors++;
    }
  }

  return { copied, skipped, errors };
}

async function bookDisplayName(
  bookId: string,
  comicDir: string,
): Promise<string> {
  const configPath = join(comicDir, "book-config.json");
  if (await fs.pathExists(configPath)) {
    const cfg = (await fs.readJson(configPath)) as { title?: string };
    if (cfg.title) return cfg.title;
  }
  return bookId
    .split("-")
    .map((word) => word.toUpperCase())
    .join(" ");
}

async function publishToSupabase(
  book: string,
  issue: string,
  issueDir: string,
): Promise<void> {
  const { supabase } = await import("./lib/supabase.js");
  const bookId = book;
  const issueId = issue;
  const issueNum = parseInt(issueId.replace(/\D/g, "") || "0", 10);
  const comicDir = join(PROJECT_ROOT, "assets", "comics", bookId);
  const name = await bookDisplayName(bookId, comicDir);
  const slug = bookId;

  const { error: bookError } = await supabase
    .from("books")
    .upsert({ id: bookId, name, slug }, { onConflict: "id" });
  if (bookError) throw new Error(`books upsert: ${bookError.message}`);
  console.log("   ✓ books row\n");

  const pagesWebpDir = join(issueDir, "pages-webp");
  const audioDir = join(issueDir, "audio");
  const webpList = (await fs.pathExists(pagesWebpDir))
    ? (await fs.readdir(pagesWebpDir)).filter((f) => f.endsWith(".webp"))
    : [];
  const audioList = (await fs.pathExists(audioDir))
    ? (await fs.readdir(audioDir)).filter((f) => f.endsWith(".mp3"))
    : [];

  const limit = pLimit(10);
  const pageDone = { n: 0 };
  const totalPages = webpList.length;
  const pageUploads = webpList.map((file) =>
    limit(async () => {
      const pNum = pageNumFromKey(`${basename(file, ".webp")}.jpg`);
      const padded = String(pNum).padStart(2, "0");
      const storagePath = `${bookId}/${issueId}/page-${padded}.webp`;
      const buf = await fs.readFile(join(pagesWebpDir, file));
      const { error: up } = await supabase.storage
        .from("comic-pages")
        .upload(storagePath, buf, {
          contentType: "image/webp",
          upsert: true,
        });
      if (up)
        throw new Error(`comic-pages upload ${storagePath}: ${up.message}`);
      pageDone.n += 1;
      console.log(`   Uploading pages (${pageDone.n}/${totalPages})...`);
    }),
  );
  await Promise.all(pageUploads);

  const audioDone = { n: 0 };
  const totalAudio = audioList.length;
  const audioUploads = audioList.map((file) =>
    limit(async () => {
      const storagePath = `${bookId}/${issueId}/${file}`;
      const buf = await fs.readFile(join(audioDir, file));
      const { error: up } = await supabase.storage
        .from("comic-audio")
        .upload(storagePath, buf, {
          contentType: "audio/mpeg",
          upsert: true,
        });
      if (up) {
        throw new Error(`comic-audio upload ${storagePath}: ${up.message}`);
      }
      audioDone.n += 1;
      console.log(`   Uploading audio (${audioDone.n}/${totalAudio})...`);
    }),
  );
  await Promise.all(audioUploads);

  const pagesPath = join(issueDir, "pages.json");
  if (await fs.pathExists(pagesPath)) {
    const pagesData = (await fs.readJson(pagesPath)) as Record<
      string,
      { width: number; height: number }
    >;
    const pageRows = Object.entries(pagesData).map(([key, dims]) => {
      const number = pageNumFromKey(key);
      const pad = String(number).padStart(2, "0");
      return {
        book_id: bookId,
        issue_id: issueId,
        number,
        width: dims.width,
        height: dims.height,
        storage_path: `${bookId}/${issueId}/page-${pad}.webp`,
      };
    });
    const { error: pe } = await supabase
      .from("pages")
      .upsert(pageRows, { onConflict: "book_id,issue_id,number" });
    if (pe) throw new Error(`pages upsert: ${pe.message}`);
    console.log(`   ✓ pages rows (${pageRows.length})\n`);
  }

  const bubblesPath = join(issueDir, "bubbles.json");
  if (!(await fs.pathExists(bubblesPath))) {
    throw new Error(`bubbles.json not found: ${bubblesPath}`);
  }
  const bubblesData = (await fs.readJson(bubblesPath)) as Record<
    string,
    BubbleJson[]
  >;

  const { data: existingBubbles, error: exErr } = await supabase
    .from("bubbles")
    .select("id, legacy_id")
    .eq("book_id", bookId)
    .eq("issue_id", issueId);
  if (exErr) throw new Error(`bubbles select: ${exErr.message}`);

  const legacyIdToUuid = new Map(
    (existingBubbles ?? []).map((r) => [r.legacy_id as string, r.id as string]),
  );

  for (const [pageKey, bubbles] of Object.entries(bubblesData)) {
    const pageNumber = pageNumFromKey(pageKey);
    for (let sortIndex = 0; sortIndex < bubbles.length; sortIndex++) {
      const bubble = bubbles[sortIndex]!;
      const existingUuid = legacyIdToUuid.get(bubble.id);
      if (existingUuid) {
        const updatePayload = bubbleToRow(
          bookId,
          issueId,
          pageNumber,
          sortIndex,
          bubble,
          null,
        );
        const { error: ue } = await supabase
          .from("bubbles")
          .update(updatePayload)
          .eq("id", existingUuid);
        if (ue) throw new Error(`bubble update ${bubble.id}: ${ue.message}`);
      } else {
        const row = bubbleToRow(
          bookId,
          issueId,
          pageNumber,
          sortIndex,
          bubble,
          {
            audio_storage_path: `${bubble.id}.mp3`,
          },
        );
        const { data: ins, error: insE } = await supabase
          .from("bubbles")
          .insert(row)
          .select("id")
          .single();
        if (insE)
          throw new Error(`bubble insert ${bubble.id}: ${insE.message}`);
        legacyIdToUuid.set(bubble.id, ins!.id);
      }
    }
  }
  console.log("   ✓ bubbles synced\n");

  const audioTsPath = join(issueDir, "audio-timestamps.json");
  if (await fs.pathExists(audioTsPath)) {
    const tsData = (await fs.readJson(audioTsPath)) as Record<string, unknown>;
    const rows: {
      bubble_id: string;
      book_id: string;
      issue_id: string;
      alignment: unknown;
      normalized_alignment: unknown;
    }[] = [];
    let skipped = 0;
    for (const [legacyId, raw] of Object.entries(tsData)) {
      const uuid = legacyIdToUuid.get(legacyId);
      if (!uuid) {
        console.warn(
          `   ⚠ no bubble UUID for timestamp ${legacyId} — skipping`,
        );
        skipped++;
        continue;
      }
      const ts = raw as {
        alignment?: unknown;
        normalized_alignment?: unknown;
        normalizedAlignment?: unknown;
      };
      rows.push({
        bubble_id: uuid,
        book_id: bookId,
        issue_id: issueId,
        alignment: ts.alignment ?? null,
        normalized_alignment:
          ts.normalized_alignment ?? ts.normalizedAlignment ?? null,
      });
    }
    if (rows.length > 0) {
      const { error: tsE } = await supabase
        .from("audio_timestamps")
        .upsert(rows, { onConflict: "bubble_id" });
      if (tsE) throw new Error(`audio_timestamps upsert: ${tsE.message}`);
    }
    console.log(
      `   ✓ audio_timestamps (${rows.length} rows${skipped > 0 ? `, ${skipped} skipped` : ""})\n`,
    );
  }

  const castlistPath = join(issueDir, "castlist.json");
  if (await fs.pathExists(castlistPath)) {
    const castData = (await fs.readJson(castlistPath)) as Record<
      string,
      string
    >;
    const castRows = Object.entries(castData).map(([character, voice_id]) => ({
      book_id: bookId,
      issue_id: issueId,
      character,
      voice_id,
    }));
    if (castRows.length > 0) {
      const { error: ce } = await supabase
        .from("castlist")
        .upsert(castRows, { onConflict: "book_id,issue_id,character" });
      if (ce) throw new Error(`castlist upsert: ${ce.message}`);
    }
    console.log(`   ✓ castlist (${castRows.length} entries)\n`);
  }

  const bubbleCount = Object.values(bubblesData).reduce(
    (s, a) => s + a.length,
    0,
  );

  let finalPageCount = 0;
  if (await fs.pathExists(pagesPath)) {
    const pd = (await fs.readJson(pagesPath)) as Record<string, unknown>;
    finalPageCount = Object.keys(pd).length;
  } else {
    finalPageCount = webpList.length;
  }

  const tsFileForCount = join(issueDir, "audio-timestamps.json");
  const hasTimestamps = await fs.pathExists(tsFileForCount);
  const audioForIssue = hasTimestamps
    ? Object.keys(
        (await fs.readJson(tsFileForCount)) as Record<string, unknown>,
      ).length
    : 0;
  const hasWebp = webpList.length > 0;
  const hasAudio = audioList.length > 0;

  const { error: issueErr } = await supabase.from("issues").upsert(
    {
      id: issueId,
      book_id: bookId,
      number: issueNum,
      name: `Issue ${issueNum}`,
      page_count: finalPageCount,
      bubble_count: bubbleCount,
      audio_count: audioForIssue,
      has_webp: hasWebp,
      has_audio: hasAudio,
      has_timestamps: hasTimestamps,
      status: "ready",
      pipeline_step: "copy-to-public",
    },
    { onConflict: "book_id,id" },
  );
  if (issueErr) throw new Error(`issues upsert: ${issueErr.message}`);

  console.log("   ✓ issues row updated\n");
}

async function runLocalCopy(
  book: string,
  issue: string,
  overwrite: boolean,
): Promise<{
  totalCopied: number;
  totalSkipped: number;
  totalErrors: number;
  publicComicDir: string;
}> {
  const COMIC_DIR = join(PROJECT_ROOT, "assets", "comics", book);
  const ISSUE_DIR = join(COMIC_DIR, issue);
  const PUBLIC_COMIC_DIR = join(PROJECT_ROOT, "public", "comics", book, issue);

  console.log(`📁 Issue: ${issue}`);
  console.log(`📖 Source: ${ISSUE_DIR}`);
  console.log(`💾 Destination: ${PUBLIC_COMIC_DIR}`);
  console.log(`🔄 Overwrite: ${overwrite ? "Yes" : "No"}\n`);

  if (!(await fs.pathExists(ISSUE_DIR))) {
    console.error(`❌ Issue directory not found: ${ISSUE_DIR}`);
    process.exit(1);
  }

  await fs.ensureDir(PUBLIC_COMIC_DIR);

  let totalCopied = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  console.log("🖼️  Copying WebP page images...");
  const pagesWebpSource = join(ISSUE_DIR, "pages-webp");
  const pagesWebpDest = join(PUBLIC_COMIC_DIR, "pages");
  const pagesResult = await copyFiles(
    pagesWebpSource,
    pagesWebpDest,
    ".webp",
    "WebP pages",
    overwrite,
  );
  totalCopied += pagesResult.copied;
  totalSkipped += pagesResult.skipped;
  totalErrors += pagesResult.errors;
  console.log(
    `   ✓ Copied: ${pagesResult.copied}, Skipped: ${pagesResult.skipped}, Errors: ${pagesResult.errors}\n`,
  );

  console.log("🎵 Copying audio files...");
  const audioSource = join(ISSUE_DIR, "audio");
  const audioDest = join(PUBLIC_COMIC_DIR, "audio");
  const audioResult = await copyFiles(
    audioSource,
    audioDest,
    ".mp3",
    "Audio",
    overwrite,
  );
  totalCopied += audioResult.copied;
  totalSkipped += audioResult.skipped;
  totalErrors += audioResult.errors;
  console.log(
    `   ✓ Copied: ${audioResult.copied}, Skipped: ${audioResult.skipped}, Errors: ${audioResult.errors}\n`,
  );

  console.log("📄 Copying bubbles.json...");
  const bubblesSource = join(ISSUE_DIR, "bubbles.json");
  const bubblesDest = join(PUBLIC_COMIC_DIR, "bubbles.json");
  if (await fs.pathExists(bubblesSource)) {
    if (!overwrite && (await fs.pathExists(bubblesDest))) {
      console.log("   ⏭️  Skipped (already exists)\n");
      totalSkipped++;
    } else {
      await fs.copy(bubblesSource, bubblesDest);
      console.log("   ✓ Copied\n");
      totalCopied++;
    }
  } else {
    console.log("   ⚠️  File not found\n");
  }

  console.log("📄 Copying pages.json...");
  const pagesSource = join(ISSUE_DIR, "pages.json");
  const pagesDest = join(PUBLIC_COMIC_DIR, "pages.json");
  if (await fs.pathExists(pagesSource)) {
    if (!overwrite && (await fs.pathExists(pagesDest))) {
      console.log("   ⏭️  Skipped (already exists)\n");
      totalSkipped++;
    } else {
      await fs.copy(pagesSource, pagesDest);
      console.log("   ✓ Copied\n");
      totalCopied++;
    }
  } else {
    console.log("   ⚠️  File not found (optional)\n");
  }

  console.log("⏱️  Copying audio-timestamps.json...");
  const timestampsSource = join(ISSUE_DIR, "audio-timestamps.json");
  const timestampsDest = join(PUBLIC_COMIC_DIR, "audio-timestamps.json");
  if (await fs.pathExists(timestampsSource)) {
    if (!overwrite && (await fs.pathExists(timestampsDest))) {
      console.log("   ⏭️  Skipped (already exists)\n");
      totalSkipped++;
    } else {
      await fs.copy(timestampsSource, timestampsDest);
      console.log("   ✓ Copied\n");
      totalCopied++;
    }
  } else {
    console.log("   ⚠️  File not found\n");
  }

  console.log("🎭 Copying castlist.json...");
  const castlistSource = join(ISSUE_DIR, "castlist.json");
  const castlistDest = join(PUBLIC_COMIC_DIR, "castlist.json");
  if (await fs.pathExists(castlistSource)) {
    if (!overwrite && (await fs.pathExists(castlistDest))) {
      console.log("   ⏭️  Skipped (already exists)\n");
      totalSkipped++;
    } else {
      await fs.copy(castlistSource, castlistDest);
      console.log("   ✓ Copied\n");
      totalCopied++;
    }
  } else {
    console.log("   ⚠️  File not found\n");
  }

  return {
    totalCopied,
    totalSkipped,
    totalErrors,
    publicComicDir: PUBLIC_COMIC_DIR,
  };
}

/**
 * Main execution
 */
async function main() {
  try {
    console.log("📦 Starting copy to public directory...\n");

    const { book, issue, overwrite, modeArg } = parseArgs();
    const storageMode = resolveStorageMode(modeArg);
    const COMIC_DIR = join(PROJECT_ROOT, "assets", "comics", book);
    const ISSUE_DIR = join(COMIC_DIR, issue);

    console.log(
      `📦 STORAGE_MODE: ${storageMode}${modeArg ? " (--mode)" : process.env.STORAGE_MODE ? " (from env)" : " (default)"}\n`,
    );

    if (storageMode === "supabase") {
      console.log(`📁 Issue: ${issue}`);
      console.log(`📖 Source: ${ISSUE_DIR}\n`);
    }

    if (storageMode === "local" || storageMode === "both") {
      const { totalCopied, totalSkipped, totalErrors } = await runLocalCopy(
        book,
        issue,
        overwrite ?? false,
      );
      console.log("📊 Summary:");
      console.log(`   Files copied: ${totalCopied}`);
      console.log(`   Files skipped: ${totalSkipped}`);
      console.log(`   Errors: ${totalErrors}`);
      console.log(`\n✅ Copy complete!`);
      console.log(`\n📂 Files are now available at: /comics/${book}/${issue}/`);
    }

    if (storageMode === "supabase" || storageMode === "both") {
      console.log("\n☁️  Publishing to Supabase...\n");
      if (!(await fs.pathExists(ISSUE_DIR))) {
        console.error(`❌ Issue directory not found: ${ISSUE_DIR}`);
        process.exit(1);
      }
      await publishToSupabase(book, issue, ISSUE_DIR);
      console.log("✅ Supabase publish complete!\n");
    }
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

main();

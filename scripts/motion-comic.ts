#!/usr/bin/env node

import fs from "fs-extra";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn, execFile as execFileCb, exec as execCb } from "child_process";
import { promisify } from "util";
import * as readline from "readline";

const execFile = promisify(execFileCb);
const exec = promisify(execCb);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

const SILENCE_GAP_S = 0.3;
const MIN_PAGE_DURATION_S = 3.0;
const VIDEO_TAIL_S = 0.5;
const VIDEO_FPS = 24;
const OUTPUT_W = 1080;
const OUTPUT_H = 1620;

interface Bubble {
  id: string;
  type: string;
}

type BubblesJson = Record<string, Bubble[]>;

interface TimestampEntry {
  alignment: {
    characters: string[];
    character_start_times_seconds: number[];
    character_end_times_seconds: number[];
  };
}

type AudioTimestamps = Record<string, TimestampEntry>;

interface PagePlan {
  pageKey: string;
  pageNum: number;
  bubbleCount: number;
  audioDuration: number;
  videoDuration: number;
  missingAudio: string[];
}

// ─── Arg parsing ────────────────────────────────────────────────────────────

function parseArgs(): { book: string; issue: string; dryRun: boolean } {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage: pnpm motion-comic -- --book <name> --issue <n> [options]

Options:
  --book=NAME, --book NAME     Book name (required)
  --issue=N, --issue N         Issue number (required)
  --dry-run                    Print page plan and exit without generating
  --help, -h                   Show this help message

Examples:
  pnpm motion-comic -- --book tmnt-mmpr-iii --issue 1
  pnpm motion-comic -- --book tmnt-mmpr-iii --issue 1 --dry-run
`);
    process.exit(0);
  }

  let book = "";
  let issue = "";
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg.startsWith("--book=")) {
      book = arg.split("=")[1]?.trim() ?? "";
    } else if (arg === "--book") {
      book = args[i + 1]?.trim() ?? "";
    } else if (arg.startsWith("--issue=")) {
      const n = arg.split("=")[1]?.trim() ?? "";
      issue = n.startsWith("issue-") ? n : `issue-${n}`;
    } else if (arg === "--issue") {
      const n = args[i + 1]?.trim() ?? "";
      issue = n.startsWith("issue-") ? n : `issue-${n}`;
    } else if (arg === "--dry-run") {
      dryRun = true;
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

  return { book, issue, dryRun };
}

// ─── FFmpeg runner ───────────────────────────────────────────────────────────

function runFFmpeg(args: string[], label?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-y", ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderrBuf = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderrBuf += d.toString();
      if (stderrBuf.length > 20000) stderrBuf = stderrBuf.slice(-10000);
    });

    child.on("close", (code) => {
      if (code === 0) return resolve();
      reject(
        new Error(
          `FFmpeg ${label ?? "command"} failed (code ${code}):\n${stderrBuf.slice(-800)}`,
        ),
      );
    });

    child.on("error", (err) =>
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}`)),
    );
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pageNumFromKey(key: string): number {
  const m = /page-0*(\d+)/i.exec(key);
  return m ? parseInt(m[1]!, 10) : 0;
}

function zeroPad(n: number): string {
  return String(n).padStart(2, "0");
}

function bubbleDuration(id: string, ts: AudioTimestamps): number | null {
  const entry = ts[id];
  if (!entry) return null;
  const times = entry.alignment.character_end_times_seconds;
  if (!times || times.length === 0) return null;
  return times[times.length - 1] ?? null;
}

// ─── Plan building ───────────────────────────────────────────────────────────

function buildPlans(
  bubbles: BubblesJson,
  ts: AudioTimestamps,
  audioDir: string,
): PagePlan[] {
  const keys = Object.keys(bubbles).sort(
    (a, b) => pageNumFromKey(a) - pageNumFromKey(b),
  );

  return keys.map((pageKey) => {
    const dialogue = (bubbles[pageKey] ?? []).filter(
      (b) => b.type !== "SFX" && b.type !== "BACKGROUND",
    );

    let totalAudio = 0;
    let present = 0;
    const missingAudio: string[] = [];

    for (const b of dialogue) {
      const p = join(audioDir, `${b.id}.mp3`);
      if (!fs.existsSync(p)) {
        missingAudio.push(`${b.id}.mp3`);
        continue;
      }
      const dur = bubbleDuration(b.id, ts);
      if (dur === null) continue;
      totalAudio += dur;
      present++;
    }

    if (present > 1) totalAudio += SILENCE_GAP_S * (present - 1);

    const audioDuration = totalAudio > 0 ? totalAudio : MIN_PAGE_DURATION_S;

    return {
      pageKey,
      pageNum: pageNumFromKey(pageKey),
      bubbleCount: dialogue.length,
      audioDuration,
      videoDuration: audioDuration + VIDEO_TAIL_S,
      missingAudio,
    };
  });
}

function printPlan(plans: PagePlan[], book: string, issue: string): void {
  const totalS = plans.reduce((s, p) => s + p.audioDuration, 0);
  const mins = Math.floor(totalS / 60);
  const secs = Math.round(totalS % 60);

  console.log(`\n📽  Motion Comic Plan — ${book} / ${issue}\n`);
  console.log(`   Page  Bubbles  Audio Duration  Video Duration`);
  console.log(`   ───────────────────────────────────────────────`);

  for (const p of plans) {
    const pg = zeroPad(p.pageNum).padEnd(4);
    const bc = String(p.bubbleCount).padEnd(7);
    const ad = `${p.audioDuration.toFixed(1)}s`.padEnd(14);
    const vd = `${p.videoDuration.toFixed(1)}s`;
    const warn =
      p.missingAudio.length > 0 ? `  ⚠️  ${p.missingAudio.length} missing` : "";
    console.log(`   ${pg}  ${bc}  ${ad}  ${vd}${warn}`);
  }

  console.log(`   ───────────────────────────────────────────────`);
  console.log(`   Total:          ~${mins}m ${secs}s\n`);

  // Missing audio detail
  const pagesWithMissing = plans.filter((p) => p.missingAudio.length > 0);
  if (pagesWithMissing.length > 0) {
    const totalMissing = pagesWithMissing.reduce(
      (n, p) => n + p.missingAudio.length,
      0,
    );
    console.log(
      `⚠️  Missing audio files (${totalMissing} file(s) across ${pagesWithMissing.length} page(s)):\n`,
    );
    for (const p of pagesWithMissing) {
      console.log(`   Page ${zeroPad(p.pageNum)}:`);
      for (const f of p.missingAudio) {
        console.log(`      • ${f}`);
      }
    }
    console.log();
  }
}

// ─── Prompt ──────────────────────────────────────────────────────────────────

async function promptConfirm(): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question("Proceed? [Y/n] ", (ans) => {
      rl.close();
      resolve(ans.trim().toLowerCase() !== "n");
    });
  });
}

// ─── Step 1: Page audio ──────────────────────────────────────────────────────

async function buildPageAudio(
  plan: PagePlan,
  bubbles: BubblesJson,
  ts: AudioTimestamps,
  audioDir: string,
  tmpDir: string,
  silencePath: string,
): Promise<void> {
  const dialogue = (bubbles[plan.pageKey] ?? []).filter(
    (b) => b.type !== "SFX" && b.type !== "BACKGROUND",
  );
  const outPath = join(tmpDir, `page-${zeroPad(plan.pageNum)}-dialogue.mp3`);

  const present: string[] = [];
  for (const b of dialogue) {
    const p = join(audioDir, `${b.id}.mp3`);
    if (!(await fs.pathExists(p))) {
      process.stdout.write(`\n   ⚠️  Missing audio: ${b.id}.mp3 — skipping`);
      continue;
    }
    if (bubbleDuration(b.id, ts) === null) {
      process.stdout.write(`\n   ⚠️  No timestamp for ${b.id} — skipping`);
      continue;
    }
    present.push(p);
  }

  if (present.length === 0) {
    await runFFmpeg(
      [
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=44100:cl=stereo",
        "-t",
        String(MIN_PAGE_DURATION_S),
        "-c:a",
        "libmp3lame",
        "-q:a",
        "4",
        outPath,
      ],
      `silence-page-${plan.pageNum}`,
    );
    return;
  }

  const listPath = join(tmpDir, `page-${zeroPad(plan.pageNum)}-audio-list.txt`);
  const lines: string[] = [];
  for (let i = 0; i < present.length; i++) {
    lines.push(`file '${present[i]}'`);
    if (i < present.length - 1) lines.push(`file '${silencePath}'`);
  }
  await fs.writeFile(listPath, lines.join("\n"));

  await runFFmpeg(
    [
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-ar",
      "44100",
      "-ac",
      "2",
      "-c:a",
      "libmp3lame",
      "-q:a",
      "4",
      outPath,
    ],
    `audio-page-${plan.pageNum}`,
  );
}

// ─── Step 2: Page video (Ken Burns) ─────────────────────────────────────────

async function generatePageVideo(
  plan: PagePlan,
  pageIndex: number,
  webpPath: string,
  tmpDir: string,
): Promise<void> {
  const totalFrames = Math.ceil(plan.videoDuration * VIDEO_FPS) + 10;
  const outPath = join(tmpDir, `page-${zeroPad(plan.pageNum)}-video.mp4`);

  // Alternate zoom direction per page for visual variety
  const zExpr =
    pageIndex % 2 === 0
      ? "z='if(lte(zoom,1.0),1.5,max(1.001,zoom-0.0015))'"
      : "z='min(zoom+0.0015,1.5)'";

  const zoompan = [
    zExpr,
    "x='iw/2-(iw/zoom/2)'",
    "y='ih/2-(ih/zoom/2)'",
    `d=${totalFrames}`,
    `s=${OUTPUT_W}x${OUTPUT_H}`,
    `fps=${VIDEO_FPS}`,
  ].join(":");

  const vf = [
    `scale=${OUTPUT_W}:${OUTPUT_H}:force_original_aspect_ratio=decrease`,
    `pad=${OUTPUT_W}:${OUTPUT_H}:(ow-iw)/2:(oh-ih)/2`,
    `zoompan=${zoompan}`,
  ].join(",");

  await runFFmpeg(
    [
      "-loop",
      "1",
      "-framerate",
      String(VIDEO_FPS),
      "-i",
      webpPath,
      "-vf",
      vf,
      "-t",
      String(plan.videoDuration),
      "-r",
      String(VIDEO_FPS),
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      outPath,
    ],
    `video-page-${plan.pageNum}`,
  );
}

// ─── Step 3: Merge audio into page clip ─────────────────────────────────────

async function mergeAudio(plan: PagePlan, tmpDir: string): Promise<void> {
  const videoPath = join(tmpDir, `page-${zeroPad(plan.pageNum)}-video.mp4`);
  const audioPath = join(tmpDir, `page-${zeroPad(plan.pageNum)}-dialogue.mp3`);
  const outPath = join(tmpDir, `page-${zeroPad(plan.pageNum)}-mixed.mp4`);

  await runFFmpeg(
    [
      "-i",
      videoPath,
      "-i",
      audioPath,
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-shortest",
      outPath,
    ],
    `merge-page-${plan.pageNum}`,
  );
}

// ─── Step 4: Assemble episode ────────────────────────────────────────────────

async function assemble(
  plans: PagePlan[],
  tmpDir: string,
  outputPath: string,
): Promise<void> {
  const listPath = join(tmpDir, "concat-list.txt");
  const lines = plans.map(
    (p) => `file '${join(tmpDir, `page-${zeroPad(p.pageNum)}-mixed.mp4`)}'`,
  );
  await fs.writeFile(listPath, lines.join("\n"));
  await fs.ensureDir(dirname(outputPath));

  await runFFmpeg(
    [
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-c:v",
      "libx264",
      "-crf",
      "22",
      "-preset",
      "medium",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      outputPath,
    ],
    "assemble",
  );
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { book, issue, dryRun } = parseArgs();

  const ISSUE_DIR = join(PROJECT_ROOT, "assets", "comics", book, issue);
  const EPISODE_DIR = join(PROJECT_ROOT, "assets", "episodes", book, issue);
  const TMP_DIR = join(EPISODE_DIR, "_tmp");
  const OUTPUT = join(EPISODE_DIR, "assembled", "episode-motion-comic.mp4");

  // Pre-flight: ffmpeg available
  try {
    await execFile("ffmpeg", ["-version"]);
  } catch {
    console.error(
      "❌ ffmpeg is not available on PATH. Install ffmpeg and try again.",
    );
    process.exit(1);
  }

  // Pre-flight: required files and directories
  const bubblesPath = join(ISSUE_DIR, "bubbles.json");
  if (!(await fs.pathExists(bubblesPath))) {
    console.error(`❌ bubbles.json not found: ${bubblesPath}`);
    process.exit(1);
  }

  const tsPath = join(ISSUE_DIR, "audio-timestamps.json");
  if (!(await fs.pathExists(tsPath))) {
    console.error(`❌ audio-timestamps.json not found: ${tsPath}`);
    process.exit(1);
  }

  const webpDir = join(ISSUE_DIR, "pages-webp");
  if (!(await fs.pathExists(webpDir))) {
    console.error(`❌ pages-webp directory not found: ${webpDir}`);
    process.exit(1);
  }

  const bubbles = (await fs.readJson(bubblesPath)) as BubblesJson;
  const ts = (await fs.readJson(tsPath)) as AudioTimestamps;
  const audioDir = join(ISSUE_DIR, "audio");

  const plans = buildPlans(bubbles, ts, audioDir);
  printPlan(plans, book, issue);

  if (dryRun) return;

  const go = await promptConfirm();
  if (!go) {
    console.log("Aborted.");
    process.exit(0);
  }

  await fs.ensureDir(TMP_DIR);

  // Generate the inter-bubble silence file once
  const silencePath = join(TMP_DIR, "silence-gap.mp3");
  process.stdout.write("\n🔇 Generating silence gap...");
  await runFFmpeg(
    [
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=44100:cl=stereo",
      "-t",
      String(SILENCE_GAP_S),
      "-c:a",
      "libmp3lame",
      "-q:a",
      "4",
      silencePath,
    ],
    "silence-gap",
  );
  console.log(" ✓");

  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i]!;
    console.log(
      `\n📄 Page ${zeroPad(plan.pageNum)} (${i + 1}/${plans.length})`,
    );

    const webpPath = join(
      webpDir,
      plan.pageKey.replace(/\.(jpe?g|png)$/i, ".webp"),
    );
    if (!(await fs.pathExists(webpPath))) {
      console.error(`❌ WebP not found: ${webpPath}`);
      process.exit(1);
    }

    process.stdout.write("   [1/3] Audio track...");
    await buildPageAudio(plan, bubbles, ts, audioDir, TMP_DIR, silencePath);
    console.log(" ✓");

    process.stdout.write("   [2/3] Ken Burns video...");
    await generatePageVideo(plan, i, webpPath, TMP_DIR);
    console.log(" ✓");

    process.stdout.write("   [3/3] Merging...");
    await mergeAudio(plan, TMP_DIR);
    console.log(" ✓");
  }

  console.log("\n🎬 Assembling final episode...");
  await assemble(plans, TMP_DIR, OUTPUT);

  console.log("🧹 Cleaning up temp files...");
  await fs.remove(TMP_DIR);

  console.log(`\n✅ Done!\n   ${OUTPUT}\n`);

  if (process.platform === "darwin") {
    exec(`open "${OUTPUT}"`).catch(() => {});
  }
}

main().catch((err: unknown) => {
  console.error("❌ Fatal error:", err instanceof Error ? err.message : err);
  process.exit(1);
});

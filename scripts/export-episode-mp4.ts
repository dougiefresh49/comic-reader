#!/usr/bin/env node
/**
 * Bake the live motion-comic to an MP4 via headless Chromium + ffmpeg.
 *
 * Pipeline:
 *   1. Spin up Playwright Chromium with screen recording enabled.
 *   2. Navigate to /episode-render/<book>/<issue> (?page=N optional).
 *   3. Wait until the route signals completion via
 *      `window.__episodeRenderDone === true`.
 *   4. Stop recording — we get a WebM with the full panel sequence.
 *   5. Mux audio in via ffmpeg: page-by-page, panel-by-panel build
 *      a layered audio track from bubble dialogue + library
 *      ambience/sfx/music. (Currently this step is a TODO — for now we
 *      ship the silent video and let the user listen via the live
 *      reader. The video alone is still useful for sharing.)
 *
 * Usage:
 *   pnpm export-episode-mp4 -- --book tmnt-mmpr-iii --issue 1
 *   pnpm export-episode-mp4 -- --book ... --issue ... --page 3
 *   pnpm export-episode-mp4 -- ... --upload   # push to Supabase too
 */

import { chromium } from "playwright";
import path from "path";
import fs from "fs";
import { execSync, spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { createClient } from "@supabase/supabase-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = path.join(__dirname, "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const BOOK = arg("book");
const ISSUE = arg("issue");
const PAGE = arg("page");
const UPLOAD = process.argv.includes("--upload");
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";

if (!BOOK || !ISSUE) {
  console.error(
    "Usage: pnpm export-episode-mp4 -- --book <id> --issue <id> [--page <n>] [--upload]",
  );
  process.exit(1);
}

const PAGE_QUERY = PAGE ? `?page=${PAGE}` : "";
const RENDER_URL = `${BASE_URL}/episode-render/${BOOK}/${ISSUE}${PAGE_QUERY}`;

const OUT_DIR = path.join(ROOT, "out", "episodes", BOOK, ISSUE);
fs.mkdirSync(OUT_DIR, { recursive: true });

const VIDEO_NAME = PAGE ? `page-${PAGE}.webm` : "episode.webm";
const MP4_NAME = PAGE ? `page-${PAGE}.mp4` : "episode.mp4";

async function main() {
  console.log(`▶  Recording ${RENDER_URL}`);
  console.log(`   Output: ${OUT_DIR}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 720, height: 1080 }, // 2:3 portrait
    deviceScaleFactor: 2,
    recordVideo: {
      dir: OUT_DIR,
      size: { width: 720, height: 1080 },
    },
  });
  const page = await context.newPage();
  await page.goto(RENDER_URL, { waitUntil: "networkidle", timeout: 60000 });

  // Wait until the render client signals completion.
  console.log("   Recording…");
  await page.waitForFunction(
    () =>
      (window as unknown as { __episodeRenderDone?: boolean })
        .__episodeRenderDone === true,
    { timeout: 30 * 60 * 1000 }, // up to 30 minutes — full issue ~14 min
  );

  const video = page.video();
  await page.close();
  await context.close();
  await browser.close();

  if (!video) throw new Error("No video stream from playwright");
  const recordedPath = await video.path();
  const finalWebm = path.join(OUT_DIR, VIDEO_NAME);
  fs.renameSync(recordedPath, finalWebm);
  console.log(`✓ recorded ${finalWebm}`);

  // Transcode WebM → MP4. ffmpeg-static is already a project dep.
  const mp4Path = path.join(OUT_DIR, MP4_NAME);
  await transcodeToMp4(finalWebm, mp4Path);
  console.log(`✓ muxed ${mp4Path}`);

  if (UPLOAD) {
    const uploaded = await uploadToBucket(mp4Path, BOOK!, ISSUE!, MP4_NAME);
    console.log(`✓ uploaded ${uploaded}`);
  }
}

async function transcodeToMp4(input: string, output: string): Promise<void> {
  // Use the bundled ffmpeg-static binary so we don't depend on the
  // user having ffmpeg on PATH.
  const ffmpegMod = await import("ffmpeg-static");
  const ffmpeg = (ffmpegMod.default ?? ffmpegMod) as unknown as string;
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, [
      "-y",
      "-i",
      input,
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "22",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      output,
    ]);
    proc.stderr.on("data", (d) => process.stdout.write(d));
    proc.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`)),
    );
  });
}

async function uploadToBucket(
  localPath: string,
  book: string,
  issue: string,
  filename: string,
): Promise<string> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !supabaseKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY not set");
  }
  const sb = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
  });
  const buf = fs.readFileSync(localPath);
  const storagePath = `${book}/${issue}/${filename}`;
  const { error } = await sb.storage
    .from("comic-audio") // reusing existing public bucket; could create a "comic-videos" later
    .upload(storagePath, buf, { contentType: "video/mp4", upsert: true });
  if (error) throw new Error(error.message);
  return `${supabaseUrl.replace(/\/$/, "")}/storage/v1/object/public/comic-audio/${storagePath}`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

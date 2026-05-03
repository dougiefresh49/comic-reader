#!/usr/bin/env node

/**
 * Voice clip splitting tool.
 * Isolates a target character's voice from mixed audio using:
 * 1. Source separation (audio-separator) — removes music/SFX
 * 2. Speaker diarization (pyannote) — identifies who speaks when
 * 3. Speaker identification (Gemini) — matches speaker labels to characters
 * 4. Extraction (ffmpeg) — slices and concatenates target speaker segments
 */

import fs from "fs-extra";
import { spawn } from "child_process";
import { join, dirname, basename, extname } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import * as readline from "readline";
import { GoogleGenAI } from "@google/genai";
import { GEMINI_MEDIUM } from "./utils/models.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface DiarizationSegment {
  speaker: string;
  start: number;
  end: number;
  duration: number;
}

interface DiarizationOutput {
  summary: {
    total_segments: number;
    speakers: Record<string, { total_seconds: number; segment_count: number }>;
  };
  segments: DiarizationSegment[];
}

function parseArgs() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage: pnpm split-voice -- --input <file> --character <name> [options]

Options:
  --input=FILE         Source audio/video file (required)
  --character=NAME     Target character to isolate (required)
  --output=FILE        Output path (default: {input}_isolated.wav)
  --book=NAME          Book context for Gemini identification
  --min-duration=N     Minimum output duration in seconds (default: 60)
  --skip-separation    Skip vocal isolation (input already voice-only)
  --keep-intermediates Keep temp files after completion
  --num-speakers=N     Hint for diarization (number of expected speakers)
  --help, -h           Show this help
`);
    process.exit(0);
  }

  let input = "";
  let character = "";
  let output = "";
  let book = "";
  let minDuration = 60;
  let skipSeparation = false;
  let keepIntermediates = false;
  let numSpeakers: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--input=")) input = arg.split("=").slice(1).join("=");
    if (arg === "--input") input = args[++i] ?? "";
    if (arg.startsWith("--character="))
      character = arg.split("=").slice(1).join("=");
    if (arg === "--character") character = args[++i] ?? "";
    if (arg.startsWith("--output=")) output = arg.split("=").slice(1).join("=");
    if (arg === "--output") output = args[++i] ?? "";
    if (arg.startsWith("--book=")) book = arg.split("=").slice(1).join("=");
    if (arg === "--book") book = args[++i] ?? "";
    if (arg.startsWith("--min-duration="))
      minDuration = parseInt(arg.split("=")[1]!, 10);
    if (arg === "--min-duration") minDuration = parseInt(args[++i] ?? "60", 10);
    if (arg.startsWith("--num-speakers="))
      numSpeakers = parseInt(arg.split("=")[1]!, 10);
    if (arg === "--num-speakers") numSpeakers = parseInt(args[++i] ?? "", 10);
    if (arg === "--skip-separation") skipSeparation = true;
    if (arg === "--keep-intermediates") keepIntermediates = true;
  }

  if (!input) {
    console.error("--input is required");
    process.exit(1);
  }
  if (!character) {
    console.error("--character is required");
    process.exit(1);
  }
  if (!output) {
    const stem = basename(input, extname(input));
    output = join(dirname(input), `${stem}_isolated.wav`);
  }

  return {
    input,
    character,
    output,
    book,
    minDuration,
    skipSeparation,
    keepIntermediates,
    numSpeakers,
  };
}

function runCommand(
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts?.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
      process.stdout.write(d);
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      process.stderr.write(d);
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function checkDependency(
  cmd: string,
  checkArgs: string[],
): Promise<boolean> {
  try {
    const { code } = await runCommand(cmd, checkArgs);
    return code === 0;
  } catch {
    return false;
  }
}

async function separateVocals(
  inputPath: string,
  workDir: string,
): Promise<string> {
  console.log("\n── Step 1: Source Separation ──────────────────────────────");
  console.log("   Isolating vocals from music/SFX...\n");

  const { code } = await runCommand("audio-separator", [
    inputPath,
    "--model_filename",
    "UVR-MDX-NET-Inst_HQ_3.onnx",
    "--output_dir",
    workDir,
  ]);

  if (code !== 0) {
    throw new Error(
      "audio-separator failed. Install: pip install audio-separator[cpu]",
    );
  }

  const files = await fs.readdir(workDir);
  const vocalsFile = files.find(
    (f) => f.includes("(Vocals)") || f.includes("vocals"),
  );
  if (!vocalsFile) {
    throw new Error(
      `No vocals file found in ${workDir}. Files: ${files.join(", ")}`,
    );
  }

  const vocalsPath = join(workDir, vocalsFile);
  console.log(`   ✓ Vocals isolated: ${vocalsFile}\n`);
  return vocalsPath;
}

async function diarizeSpeakers(
  vocalsPath: string,
  workDir: string,
  numSpeakers?: number,
): Promise<DiarizationOutput> {
  console.log("\n── Step 2: Speaker Diarization ────────────────────────────");
  console.log("   Identifying speakers and their segments...\n");

  const outputPath = join(workDir, "diarization.json");
  const helperPath = join(__dirname, "helpers", "diarize.py");

  const pyArgs = ["--input", vocalsPath, "--output", outputPath];
  if (numSpeakers) pyArgs.push("--num-speakers", String(numSpeakers));

  const { code } = await runCommand("python3", [helperPath, ...pyArgs]);

  if (code !== 0) {
    throw new Error(
      "Diarization failed. Ensure: pip install pyannote.audio && HF_TOKEN is set",
    );
  }

  const result = (await fs.readJSON(outputPath)) as DiarizationOutput;
  return result;
}

async function identifySpeaker(
  diarization: DiarizationOutput,
  character: string,
  book: string,
): Promise<string> {
  console.log("\n── Step 3: Speaker Identification ─────────────────────────");

  const speakers = Object.entries(diarization.summary.speakers);
  if (speakers.length === 1) {
    console.log(`   Only one speaker found — assuming it's ${character}.\n`);
    return speakers[0]![0];
  }

  const speakerSummary = speakers
    .map(
      ([label, info]) =>
        `  ${label}: ${info.total_seconds}s across ${info.segment_count} segments`,
    )
    .join("\n");
  console.log(`   Found ${speakers.length} speakers:\n${speakerSummary}\n`);

  // Try Gemini identification if we have an API key
  if (process.env.GEMINI_API_KEY) {
    console.log("   Asking Gemini to identify the target speaker...\n");
    try {
      const identified = await geminiIdentifySpeaker(
        diarization,
        character,
        book,
      );
      if (identified) {
        console.log(`   ✓ Gemini identified ${character} as ${identified}\n`);
        return identified;
      }
    } catch (e) {
      console.log(`   Gemini identification failed: ${(e as Error).message}\n`);
    }
  }

  // Fallback: interactive selection
  return interactiveSelectSpeaker(speakers, character);
}

async function geminiIdentifySpeaker(
  diarization: DiarizationOutput,
  character: string,
  book: string,
): Promise<string | null> {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

  // Build sample text from segments (first few per speaker for context)
  const speakerSamples: Record<string, string[]> = {};
  for (const seg of diarization.segments) {
    const list = speakerSamples[seg.speaker] ?? [];
    if (list.length < 5) {
      list.push(`[${seg.start}s–${seg.end}s] (${seg.duration}s)`);
    }
    speakerSamples[seg.speaker] = list;
  }

  const context = book ? ` from the book/show "${book}"` : "";
  const prompt = `I have an audio clip${context} with ${Object.keys(speakerSamples).length} identified speakers. I need to find which speaker label corresponds to the character "${character}".

Speaker statistics:
${Object.entries(diarization.summary.speakers)
  .map(
    ([label, info]) =>
      `- ${label}: ${info.total_seconds}s total, ${info.segment_count} segments`,
  )
  .join("\n")}

Based on the character "${character}"${context}, which speaker is most likely the target? Consider:
- Main characters typically have the most dialogue
- The target character's speaking patterns and role

Reply with ONLY the speaker label (e.g., "SPEAKER_00") or "UNSURE" if you cannot determine it.`;

  const result = await ai.models.generateContent({
    model: GEMINI_MEDIUM,
    contents: prompt,
    config: { temperature: 0 },
  });

  const answer = result.text?.trim() ?? "";
  if (answer.startsWith("SPEAKER_") && diarization.summary.speakers[answer]) {
    return answer;
  }
  return null;
}

async function interactiveSelectSpeaker(
  speakers: [string, { total_seconds: number; segment_count: number }][],
  character: string,
): Promise<string> {
  console.log(`\n   Select which speaker is "${character}":\n`);
  speakers.forEach(([label, info], i) => {
    console.log(
      `   [${i + 1}] ${label} — ${info.total_seconds}s (${info.segment_count} segments)`,
    );
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question("\n   Enter number: ", (answer) => {
      rl.close();
      const idx = parseInt(answer.trim(), 10) - 1;
      if (idx >= 0 && idx < speakers.length) {
        resolve(speakers[idx]![0]);
      } else {
        console.log("   Invalid — defaulting to speaker with most dialogue.");
        resolve(speakers[0]![0]);
      }
    });
  });
}

async function extractAndConcat(
  vocalsPath: string,
  segments: DiarizationSegment[],
  targetSpeaker: string,
  outputPath: string,
  workDir: string,
): Promise<number> {
  console.log("\n── Step 4: Extract & Concatenate ──────────────────────────");

  const targetSegments = segments.filter((s) => s.speaker === targetSpeaker);
  if (targetSegments.length === 0) {
    throw new Error(`No segments found for ${targetSpeaker}`);
  }

  const totalDuration = targetSegments.reduce((sum, s) => sum + s.duration, 0);
  console.log(
    `   ${targetSegments.length} segments, ${totalDuration.toFixed(1)}s total\n`,
  );

  // Write ffmpeg concat file
  const concatList = join(workDir, "concat.txt");
  const silencePath = join(workDir, "silence.wav");

  // Generate 0.1s silence for padding between segments
  await runCommand("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=44100:cl=mono",
    "-t",
    "0.1",
    silencePath,
  ]);

  const lines: string[] = [];
  for (let i = 0; i < targetSegments.length; i++) {
    const seg = targetSegments[i]!;
    const segPath = join(workDir, `seg_${String(i).padStart(4, "0")}.wav`);

    await runCommand("ffmpeg", [
      "-y",
      "-i",
      vocalsPath,
      "-ss",
      String(seg.start),
      "-to",
      String(seg.end),
      "-ar",
      "44100",
      "-ac",
      "1",
      segPath,
    ]);

    lines.push(`file '${segPath}'`);
    if (i < targetSegments.length - 1) {
      lines.push(`file '${silencePath}'`);
    }
  }

  await fs.writeFile(concatList, lines.join("\n"));

  const { code } = await runCommand("ffmpeg", [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatList,
    "-c:a",
    "pcm_s16le",
    "-ar",
    "44100",
    "-ac",
    "1",
    outputPath,
  ]);

  if (code !== 0) {
    throw new Error("ffmpeg concatenation failed");
  }

  console.log(`   ✓ Output: ${outputPath}`);
  console.log(`   ✓ Duration: ${totalDuration.toFixed(1)}s\n`);
  return totalDuration;
}

async function main() {
  const opts = parseArgs();

  if (!(await fs.pathExists(opts.input))) {
    console.error(`Input file not found: ${opts.input}`);
    process.exit(1);
  }

  // Check dependencies
  const hasFfmpeg = await checkDependency("ffmpeg", ["-version"]);
  if (!hasFfmpeg) {
    console.error("ffmpeg not found. Install: brew install ffmpeg");
    process.exit(1);
  }

  if (!opts.skipSeparation) {
    const hasSep = await checkDependency("audio-separator", ["--help"]);
    if (!hasSep) {
      console.error(
        "audio-separator not found. Install: pip install audio-separator[cpu]",
      );
      process.exit(1);
    }
  }

  console.log(`\n🎵 Voice Clip Splitter`);
  console.log(`   Input:     ${opts.input}`);
  console.log(`   Character: ${opts.character}`);
  console.log(`   Output:    ${opts.output}`);
  if (opts.book) console.log(`   Book:      ${opts.book}`);
  console.log();

  const workDir = join(
    tmpdir(),
    `split-voice-${randomBytes(4).toString("hex")}`,
  );
  await fs.ensureDir(workDir);

  try {
    // Step 1: Source separation
    let vocalsPath: string;
    if (opts.skipSeparation) {
      console.log(
        "── Step 1: Skipped (--skip-separation) ──────────────────\n",
      );
      vocalsPath = opts.input;
    } else {
      vocalsPath = await separateVocals(opts.input, workDir);
    }

    // Step 2: Diarization
    const diarization = await diarizeSpeakers(
      vocalsPath,
      workDir,
      opts.numSpeakers,
    );

    // Step 3: Identify target speaker
    const targetSpeaker = await identifySpeaker(
      diarization,
      opts.character,
      opts.book,
    );

    // Step 4: Extract and concatenate
    const duration = await extractAndConcat(
      vocalsPath,
      diarization.segments,
      targetSpeaker,
      opts.output,
      workDir,
    );

    // Validate
    if (duration < opts.minDuration) {
      console.log(
        `⚠️  Output is ${duration.toFixed(1)}s — below the ${opts.minDuration}s minimum.`,
      );
      console.log(`   ElevenLabs IVC works best with ≥60s of clean speech.`);
      console.log(`   Consider finding a longer source clip.\n`);
    } else {
      console.log(`✅ Done! ${duration.toFixed(1)}s of isolated speech.\n`);
    }
  } finally {
    if (!opts.keepIntermediates) {
      await fs.remove(workDir);
    } else {
      console.log(`   Intermediates kept at: ${workDir}\n`);
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

#!/usr/bin/env node

/**
 * Render one line with the pipeline's exact TTS request, for listening next to
 * the audio the pipeline already made.
 *
 * The request comes from `buildTtsRequest` (#103), the same call the audio step
 * makes, so what this renders is what a kid hears. The default run is a dry run:
 * it prints the request and the character count and spends nothing. `--execute`
 * makes the one paid call and writes to `tmp/render-bubble/`, never to Storage
 * and never to the database.
 *
 * Usage:
 *   pnpm render-bubble -- --bubble <uuid> --book <id> --issue <id> [--voice <el id>]
 *   pnpm render-bubble -- --text "<line>" --emotion <word> --voice <el id>
 *   pnpm render-bubble -- --batch <file.jsonl> --max 3
 *
 * See `--help` for every flag.
 */

import fs from "fs-extra";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { getElevenLabsClient } from "~/lib/elevenlabs-client";
import { buildTtsRequest, type TtsRequest } from "~/lib/tts-request";
import { supabase } from "./lib/supabase.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");
const OUT_DIR = join(PROJECT_ROOT, "tmp", "render-bubble");

/** One render's worth of flags, the shape a `--batch` line also holds. */
interface LineSpec {
  bubble?: string;
  book?: string;
  issue?: string;
  text?: string;
  emotion?: string;
  voice?: string;
  stability?: number;
  style?: number;
  speed?: number;
  context?: boolean;
  label?: string;
}

interface Args extends LineSpec {
  batch?: string;
  max: number;
  execute: boolean;
}

const HELP = `
Usage: pnpm render-bubble -- <source> [options]

Sources (pick one):
  --bubble <uuid>    Read text_with_cues ?? ocr_text and emotion from bubbles.
  --text "<line>"    Render a line you type.

Context for a --bubble read (both required with it):
  --book <id>        book_id, e.g. tmnt-mmpr-iii
  --issue <id>       issue_id, e.g. issue-1

Overrides:
  --voice <el id>    ElevenLabs voice id. Required when the castlist lookup
                     misses, which it does today: bubble speakers are slugs
                     like "soldier" while castlist.character is "Soldier" (#90).
  --emotion <word>   Emotion, with --text or to replace the bubble's own.
  --stability <n>    0 to 1
  --style <n>        0 to 1
  --speed <n>        0.7 to 1.2. Inert on eleven_v3, which ignores it.
  --context          Send previous_text and next_text.
  --label <name>     Output name under tmp/render-bubble/ (default: derived).

Batch:
  --batch <file.jsonl>   One JSON object per line, holding the same fields.
  --max <n>              Refuse to run more than this many lines (default 1).

Other:
  --execute          Render for real. Costs one ElevenLabs call. Writes only
                     under tmp/render-bubble/. Default is a free dry run.

  -h, --help         This text.
`;

function fail(message: string): never {
  console.error(`❌ ${message}`);
  process.exit(1);
}

function takeValue(argv: string[], i: number, flag: string): string {
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) fail(`${flag} needs a value`);
  return v;
}

function takeNumber(argv: string[], i: number, flag: string): number {
  const raw = takeValue(argv, i, flag);
  const n = Number(raw);
  if (!Number.isFinite(n)) fail(`${flag} needs a number, got '${raw}'`);
  return n;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { max: 1, execute: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    // pnpm 10 hands the `--` on through to the script.
    if (a === "--") continue;
    if (a === "-h" || a === "--help") {
      console.log(HELP);
      process.exit(0);
    } else if (a === "--bubble") args.bubble = takeValue(argv, i++, a);
    else if (a === "--book") args.book = takeValue(argv, i++, a);
    else if (a === "--issue") args.issue = takeValue(argv, i++, a);
    else if (a === "--text") args.text = takeValue(argv, i++, a);
    else if (a === "--emotion") args.emotion = takeValue(argv, i++, a);
    else if (a === "--voice") args.voice = takeValue(argv, i++, a);
    else if (a === "--stability") args.stability = takeNumber(argv, i++, a);
    else if (a === "--style") args.style = takeNumber(argv, i++, a);
    else if (a === "--speed") args.speed = takeNumber(argv, i++, a);
    else if (a === "--label") args.label = takeValue(argv, i++, a);
    else if (a === "--batch") args.batch = takeValue(argv, i++, a);
    else if (a === "--max") args.max = takeNumber(argv, i++, a);
    else if (a === "--context") args.context = true;
    else if (a === "--execute") args.execute = true;
    else fail(`Unknown flag '${a}'. Run with --help.`);
  }
  return args;
}

/** The bubble row, read by book, issue and id, as every query here filters. */
interface BubbleRow {
  id: string;
  speaker: string | null;
  emotion: string | null;
  ocr_text: string | null;
  text_with_cues: string | null;
  page_number: number;
}

async function readBubble(spec: LineSpec): Promise<BubbleRow> {
  if (!spec.bubble) fail("--bubble needs --book and --issue");
  if (!spec.book || !spec.issue) fail("--bubble needs --book and --issue");
  const { data, error } = await supabase
    .from("bubbles")
    .select("id, speaker, emotion, ocr_text, text_with_cues, page_number")
    .eq("book_id", spec.book)
    .eq("issue_id", spec.issue)
    .eq("id", spec.bubble)
    .maybeSingle();
  if (error) fail(`Reading bubble ${spec.bubble}: ${error.message}`);
  if (!data) {
    fail(
      `No bubble ${spec.bubble} in ${spec.book}/${spec.issue}. Check the id, the book and the issue.`,
    );
  }
  return data as BubbleRow;
}

/**
 * The voice for a speaker, from the castlist of that book.
 *
 * The castlist is per book (decisions row 28), but rows still carry an
 * `issue_id` until #118, so a row for another issue of the same book is a
 * usable answer and the one for this issue wins when both are there.
 */
async function readCastlistVoice(
  bookId: string,
  issueId: string,
  speaker: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("castlist")
    .select("issue_id, voice_id")
    .eq("book_id", bookId)
    .eq("character", speaker);
  if (error) fail(`Reading castlist for '${speaker}': ${error.message}`);
  const rows = (data ?? []) as { issue_id: string; voice_id: string | null }[];
  const forIssue = rows.find((r) => r.issue_id === issueId);
  const first = rows.find((r) => r.voice_id);
  return (forIssue?.voice_id ?? first?.voice_id ?? null) as string | null;
}

/** One render, before any money is spent. */
interface PlannedRender {
  label: string;
  voiceId: string;
  request: TtsRequest;
  /** Dotted paths the flags replaced, e.g. `voiceSettings.speed`. */
  overridden: string[];
  characterCount: number;
  /** The emotion the settings came from, for the print. */
  emotion: string;
  /** Where the text came from, for the print. */
  source: string;
}

function defaultLabel(spec: LineSpec, index: number): string {
  if (spec.label) return spec.label;
  if (spec.bubble) return `bubble-${spec.bubble.slice(0, 8)}`;
  const slug = (spec.text ?? "line")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const stem = slug || "line";
  return index === 0 ? stem : `${stem}-${index + 1}`;
}

async function planRender(
  spec: LineSpec,
  index: number,
): Promise<PlannedRender> {
  let text = spec.text ?? "";
  let emotion = spec.emotion ?? null;
  let speaker: string | null = null;
  let source: string;
  let bookId = spec.book ?? null;
  let issueId = spec.issue ?? null;

  if (spec.bubble) {
    const bubble = await readBubble(spec);
    text = bubble.text_with_cues ?? bubble.ocr_text ?? "";
    emotion = spec.emotion ?? bubble.emotion;
    speaker = bubble.speaker;
    bookId = bookId ?? "";
    issueId = issueId ?? "";
    source = `bubble ${bubble.id} (${spec.book}/${spec.issue} page ${bubble.page_number})`;
  } else if (spec.text !== undefined) {
    source = "--text";
  } else {
    fail(
      'Nothing to render. Pass --bubble <uuid> --book <id> --issue <id>, or --text "<line>".',
    );
  }

  if (!text.trim()) fail(`No text to render (${source}).`);

  let voiceId = spec.voice ?? null;
  if (!voiceId) {
    if (speaker && bookId && issueId) {
      voiceId = await readCastlistVoice(bookId, issueId, speaker);
    }
    if (!voiceId) {
      fail(
        `No voice for speaker '${speaker ?? "(none)"}' in the castlist of ${bookId ?? "the book"}. ` +
          `Bubble speakers are slugs and castlist.character is title case, which #90 fixes. ` +
          `Pass --voice <elevenlabs voice id>.`,
      );
    }
  }

  const request = buildTtsRequest({
    text,
    emotion,
    voiceId,
    withContext: spec.context ?? false,
  });
  const overridden: string[] = [];
  if (spec.stability !== undefined) {
    request.voiceSettings.stability = spec.stability;
    overridden.push("voiceSettings.stability");
  }
  if (spec.style !== undefined) {
    request.voiceSettings.style = spec.style;
    overridden.push("voiceSettings.style");
  }
  if (spec.speed !== undefined) {
    request.voiceSettings.speed = spec.speed;
    overridden.push("voiceSettings.speed");
  }
  if (spec.voice) overridden.push("voiceId");

  return {
    label: defaultLabel(spec, index),
    voiceId,
    request,
    overridden,
    characterCount: text.length,
    emotion: emotion ?? "neutral",
    source,
  };
}

/** The printed request, with the overridden paths named inside the JSON. */
function printableJson(render: PlannedRender): string {
  return JSON.stringify(
    {
      ...render.request,
      overridden: render.overridden,
      characterCount: render.characterCount,
    },
    null,
    2,
  );
}

function printPlan(render: PlannedRender): void {
  console.log(`\n${render.label}`);
  console.log(`   source:   ${render.source}`);
  console.log(`   emotion:  ${render.emotion}`);
  console.log(`   voice:    ${render.voiceId}`);
  console.log(`   chars:    ${render.characterCount}`);
  console.log(
    `   settings: stability ${render.request.voiceSettings.stability}, ` +
      `similarityBoost ${render.request.voiceSettings.similarityBoost}, ` +
      `style ${render.request.voiceSettings.style}, ` +
      `speed ${render.request.voiceSettings.speed}` +
      (render.overridden.length ? "" : " (all from the emotion table)"),
  );
  console.log(printableJson(render));
}

/**
 * The seconds the audio runs for, read off the alignment ElevenLabs returns
 * with the timestamps. `normalizeAlignment` in
 * `src/server/actions/review/regenerate-audio.ts` is the pipeline's version of
 * this and is not exported, so this reads both spellings of the field names.
 */
function audioDurationSeconds(alignment: unknown): number | null {
  if (!alignment || typeof alignment !== "object") return null;
  const ends =
    (alignment as Record<string, unknown>).character_end_times_seconds ??
    (alignment as Record<string, unknown>).characterEndTimesSeconds;
  if (!Array.isArray(ends) || ends.length === 0) return null;
  const last = ends[ends.length - 1];
  return typeof last === "number" ? Number(last.toFixed(3)) : null;
}

async function executeRender(render: PlannedRender): Promise<void> {
  const client = await getElevenLabsClient();
  let response;
  try {
    response = await client.textToSpeech.convertWithTimestamps(
      render.voiceId,
      render.request,
    );
  } catch (e) {
    // No retry: a second call spends a second time. Say what was spent.
    fail(`The ElevenLabs call failed: ${(e as Error).message}`);
  }
  const audio = Buffer.from(response.audioBase64, "base64");
  await fs.ensureDir(OUT_DIR);
  const mp3Path = join(OUT_DIR, `${render.label}.mp3`);
  await fs.writeFile(mp3Path, audio);
  const jsonPath = join(OUT_DIR, `${render.label}.json`);
  await fs.writeJSON(
    jsonPath,
    {
      label: render.label,
      source: render.source,
      emotion: render.emotion,
      voiceId: render.voiceId,
      request: render.request,
      overridden: render.overridden,
      characterCount: render.characterCount,
      alignment: response.alignment ?? null,
      normalizedAlignment: response.normalizedAlignment ?? null,
      audioDurationSeconds: audioDurationSeconds(response.alignment),
      audioBytes: audio.byteLength,
    },
    { spaces: 2 },
  );
  console.log(`\n   wrote ${mp3Path}`);
  console.log(`   wrote ${jsonPath}`);
}

async function readBatchFile(path: string): Promise<LineSpec[]> {
  if (!path) fail("--batch needs a file path");
  const raw = await fs.readFile(path, "utf8");
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.map((line, i) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      fail(`${path} line ${i + 1} is not JSON: ${(e as Error).message}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail(`${path} line ${i + 1} is not a JSON object.`);
    }
    return parsed as LineSpec;
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.batch) {
    const specs = await readBatchFile(args.batch);
    if (specs.length === 0) fail(`${args.batch} has no lines.`);
    const planned: PlannedRender[] = [];
    for (const [i, spec] of specs.entries()) {
      planned.push(await planRender(spec, i));
    }
    const total = planned.reduce((n, r) => n + r.characterCount, 0);
    console.log(
      `${args.batch}: ${planned.length} line(s), ${total} characters total.`,
    );
    if (planned.length > args.max) {
      fail(
        `Refusing to run ${planned.length} lines with --max ${args.max}. ` +
          `Pass --max ${planned.length} if that is the spend you want.`,
      );
    }
    for (const render of planned) {
      printPlan(render);
      if (args.execute) await executeRender(render);
    }
    if (!args.execute) {
      console.log(`\nDry run. Nothing was spent. Add --execute to render.`);
    }
    return;
  }

  const render = await planRender(args, 0);
  printPlan(render);
  if (args.execute) {
    await executeRender(render);
  } else {
    console.log(`\nDry run. Nothing was spent. Add --execute to render.`);
  }
}

main().catch((e) => {
  console.error("❌ render-bubble:", e);
  process.exit(1);
});

#!/usr/bin/env node

/**
 * Render one line with the pipeline's exact TTS request, for listening next to
 * the audio the pipeline already made.
 *
 * The request comes from `buildTtsRequest` (#103) with the voice's stored
 * `voice_settings` (#412), the same call the audio step makes, so what this
 * renders is what a kid hears. The default run is a dry run: it prints the
 * request and the character count and spends nothing. `--execute` makes the
 * one paid call and writes to `tmp/render-bubble/`, never to Storage and never
 * to the database.
 *
 * Usage:
 *   pnpm render-bubble -- --bubble <uuid> --book <id> --issue <id> [--voice <el id>]
 *   pnpm render-bubble -- --text "<line>" --voice <el id>
 *   pnpm render-bubble -- --batch <file.jsonl> --max 3
 *
 * See `--help` for every flag.
 */

import fs from "fs-extra";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadBookCast, renderVoice, type RenderVoice } from "~/lib/cast";
import { getElevenLabsClient } from "~/lib/elevenlabs-client";
import { isDryRun } from "~/lib/fakes/dry-run";
import { buildTtsRequest, type TtsRequest } from "~/lib/tts-request";
import { loadVoiceOverrides } from "~/lib/voice-overrides";
import { isAudioTag, type VoiceOverride } from "~/lib/voice-settings";
import { normalizeAlignment } from "~/workflows/steps/audio-plan";
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
  voice?: string;
  stability?: number;
  similarity?: number;
  /** Replaces the voice's stored `line_prefix`; "" means none. */
  prefix?: string;
  context?: boolean;
  label?: string;
}

/** Every field a batch line may hold. */
const LINE_FIELDS = [
  "bubble",
  "book",
  "issue",
  "text",
  "voice",
  "stability",
  "similarity",
  "prefix",
  "context",
  "label",
] as const satisfies readonly (keyof LineSpec)[];

interface Args extends LineSpec {
  batch?: string;
  max: number;
  execute: boolean;
}

const HELP = `
Usage: pnpm render-bubble -- <source> [options]

Sources (pick one):
  --bubble <uuid>    Read text_with_cues ?? ocr_text from bubbles.
  --text "<line>"    Render a line you type.

Context for a --bubble read (both required with it):
  --book <id>        book_id, e.g. tmnt-mmpr-iii
  --issue <id>       issue_id, e.g. issue-1

Overrides:
  --voice <el id>    ElevenLabs voice id. Required when the audio step's render
                     chain finds no voice for the bubble (no character_id,
                     no voice cast yet, or a voice not in a slot). With
                     --bubble the chain still runs; --voice replaces its voice.
  --stability <n>    0 to 1. Replaces the base and the voice's own value.
  --similarity <n>   0 to 1. Replaces the base and the voice's own value.
  --prefix "<tag>"   Replaces the voice's stored line_prefix for this render,
                     e.g. --prefix "[strong Japanese accent]". --prefix ""
                     renders with no prefix.
  --context         Send the adjacent bubbles as previous_text and next_text.
                     Reads the page's other bubbles in reading order, so it
                     needs a --bubble source, not --text.
  --label <name>     Output name under tmp/render-bubble/ (default: derived).
                     Letters, digits, dot, dash and underscore only.

Batch:
  --batch <file.jsonl>   One JSON object per line, holding the same fields.
  --max <n>              Refuse to run more than this many lines (default 1).

Other:
  --execute          Render for real. Costs one ElevenLabs call per render, so
                     a batch costs one per line, up to --max. Writes only
                     under tmp/render-bubble/. Default is a free dry run.

  -h, --help         This text.
`;

/** What the ElevenLabs API accepts, so a bad override fails before the call. */
const RANGES = {
  stability: [0, 1],
  similarity: [0, 1],
} as const;

function fail(message: string): never {
  console.error(`❌ ${message}`);
  process.exit(1);
}

function takeValue(argv: string[], i: number, flag: string): string {
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) fail(`${flag} needs a value`);
  return v;
}

function takeNumber(
  argv: string[],
  i: number,
  flag: string,
  range?: readonly [number, number],
): number {
  const raw = takeValue(argv, i, flag);
  const n = Number(raw);
  if (!Number.isFinite(n)) fail(`${flag} needs a number, got '${raw}'`);
  if (range && (n < range[0] || n > range[1])) {
    fail(`${flag} must be between ${range[0]} and ${range[1]}, got ${n}`);
  }
  return n;
}

/** A label becomes a file name under `tmp/render-bubble/`, so one segment. */
function checkLabel(label: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(label)) {
    fail(
      `--label must be letters, digits, dot, dash or underscore only, got '${label}'`,
    );
  }
  return label;
}

/** A prefix is "" (none) or one audio tag, the rule a stored line_prefix meets. */
function checkPrefix(prefix: string, where: string): string {
  if (prefix.trim() && !isAudioTag(prefix)) {
    fail(
      `${where} must be one audio tag like "[strong Japanese accent]", or "" for none, got '${prefix}'`,
    );
  }
  return prefix;
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
    else if (a === "--voice") args.voice = takeValue(argv, i++, a);
    else if (a === "--stability")
      args.stability = takeNumber(argv, i++, a, RANGES.stability);
    else if (a === "--similarity")
      args.similarity = takeNumber(argv, i++, a, RANGES.similarity);
    else if (a === "--prefix")
      args.prefix = checkPrefix(takeValue(argv, i++, a), a);
    else if (a === "--label") args.label = checkLabel(takeValue(argv, i++, a));
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
  character_id: string | null;
  ocr_text: string | null;
  text_with_cues: string | null;
  page_number: number;
  sort_order: number;
}

async function readBubble(spec: LineSpec): Promise<BubbleRow> {
  if (!spec.bubble) fail("--bubble needs --book and --issue");
  if (!spec.book || !spec.issue) fail("--bubble needs --book and --issue");
  const { data, error } = await supabase
    .from("bubbles")
    .select(
      "id, speaker, character_id, ocr_text, text_with_cues, page_number, sort_order",
    )
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
 * The bubble's voice by the audio step's own rule, the render chain
 * (`renderVoice`, #429) on `bubbles.character_id`. A render that spent on any
 * other answer would be audio the pipeline would never play (decisions row
 * 173).
 */
async function readBubbleVoice(
  bookId: string,
  issueId: string,
  characterId: string | null,
): Promise<RenderVoice> {
  const book = await loadBookCast(supabase, bookId).catch((e: Error) =>
    fail(e.message),
  );
  return renderVoice(book, characterId, issueId);
}

/**
 * The bubbles either side of this one on its page, in reading order, which is
 * what `previous_text` and `next_text` carry. `sort_order` is the play order
 * (#206), so it is the reading order within a page.
 */
async function readNeighbours(
  bubble: BubbleRow,
  bookId: string,
  issueId: string,
): Promise<{ previousText?: string; nextText?: string }> {
  const { data, error } = await supabase
    .from("bubbles")
    .select("id, sort_order, ocr_text, text_with_cues")
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("page_number", bubble.page_number)
    .eq("ignored", false);
  if (error) fail(`Reading the page's bubbles: ${error.message}`);
  const text = (
    r: {
      ocr_text: string | null;
      text_with_cues: string | null;
    } | null,
  ) => (r ? (r.text_with_cues ?? r.ocr_text ?? "").trim() : "");
  const rows = (
    (data ?? []) as {
      id: string;
      sort_order: number;
      ocr_text: string | null;
      text_with_cues: string | null;
    }[]
  )
    .filter((r) => r.id !== bubble.id)
    .sort((a, b) => a.sort_order - b.sort_order);
  const before = rows.filter((r) => r.sort_order < bubble.sort_order);
  const after = rows.filter((r) => r.sort_order > bubble.sort_order);
  return {
    // A first or last bubble on its page has one side and not the other.
    previousText: text(before[before.length - 1] ?? null) || undefined,
    nextText: text(after[0] ?? null) || undefined,
  };
}

/**
 * Why there is no voice, naming the render chain's case, because the fix is
 * not the same for each: a missing or unslotted voice is fixed by `--voice`
 * for this one render, a removed or "no audio" character is castlist data
 * that `--voice` would only paper over.
 */
function noVoiceMessage(
  speaker: string | null,
  bookId: string | null,
  issueId: string | null,
  miss: (RenderVoice & { ok: false }) | null,
): string {
  const who = miss?.characterId
    ? `character '${miss.characterId}'`
    : `speaker '${speaker ?? "(none)"}'`;
  const where = `${bookId ?? "the book"}/${issueId ?? "the issue"}`;
  switch (miss?.reason ?? "no bubble") {
    case "no audio":
      return (
        `The castlist row for ${who} in ${where} has no_audio set (${miss!.detail}), so ` +
        `the audio step renders no audio for it. This script will not spend a call ` +
        `on audio the pipeline never plays.`
      );
    case "removed":
      return (
        `${who} is removed from the cast of ${where} (${miss!.detail}), so the audio ` +
        `step renders no audio for it. This script will not spend a call on audio ` +
        `the pipeline never plays.`
      );
    case "not in a slot":
      return (
        `${who} is cast in ${where}, but its voice is not in a slot (${miss!.detail}). ` +
        `Put the voice in a slot first, or pass --voice <elevenlabs voice id> for ` +
        `this one render.`
      );
    case "no voice":
      return (
        `No voice for ${who} in ${where} (${miss!.detail}), so the character is cast ` +
        `without a voice yet. Cast it first, or pass --voice <elevenlabs voice id> ` +
        `for this one render.`
      );
    case "unassigned":
      return (
        `This bubble (${who}) has no character_id, so the render chain cannot ` +
        `answer and the audio step renders no audio for it. Assign it in the ` +
        `review editor, or pass --voice <elevenlabs voice id>.`
      );
    default:
      return (
        `Nothing to look up: this line has no bubble, so the castlist cannot ` +
        `answer. Pass --voice <elevenlabs voice id>.`
      );
  }
}

/** Where a setting came from: the base, the voice's `voice_settings`, or a flag. */
type SettingSource = "base" | "voice" | "flag";

/** One render, before any money is spent. */
interface PlannedRender {
  label: string;
  voiceId: string;
  request: TtsRequest;
  /** Where each setting, the line prefix and the voice came from. */
  from: {
    voiceId: "lookup" | "flag";
    stability: SettingSource;
    similarityBoost: SettingSource;
    /** "none" when neither the voice nor a flag sets one. */
    linePrefix: SettingSource | "none";
  };
  /** The prefix in front of the text, if any, for the print. */
  linePrefix: string | null;
  /** Whether the adjacent bubbles ride along. */
  withContext: boolean;
  /** `request.text.length`, prefix included: what ElevenLabs bills. */
  characterCount: number;
  /** Where the text came from, for the print. */
  source: string;
}

function defaultLabel(spec: LineSpec, index: number): string {
  const stem = spec.bubble
    ? `bubble-${spec.bubble.slice(0, 8)}`
    : (spec.text ?? "line")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 32) || "line";
  return spec.label ?? (index === 0 ? stem : `${stem}-${index + 1}`);
}

/** One mp3 and one json per label, so two renders may not share one. */
function checkDistinctLabels(planned: PlannedRender[]): void {
  const seen = new Set<string>();
  for (const render of planned) {
    if (seen.has(render.label)) {
      fail(
        `Two renders are labelled '${render.label}', so the second --execute would overwrite the first. ` +
          `Give one of them a --label.`,
      );
    }
    seen.add(render.label);
  }
}

async function planRender(
  spec: LineSpec,
  index: number,
  where: string,
): Promise<PlannedRender> {
  if (spec.bubble && spec.text !== undefined) {
    fail(`${where} sets both --bubble and --text. Pick one source.`);
  }
  let text = spec.text ?? "";
  let speaker: string | null = null;
  let characterId: string | null = null;
  let source: string;
  let bookId = spec.book ?? null;
  let issueId = spec.issue ?? null;
  let previousText: string | undefined;
  let nextText: string | undefined;

  if (spec.bubble) {
    const bubble = await readBubble(spec);
    text = bubble.text_with_cues ?? bubble.ocr_text ?? "";
    speaker = bubble.speaker;
    characterId = bubble.character_id;
    bookId = bookId ?? "";
    issueId = issueId ?? "";
    source = `bubble ${bubble.id} (${spec.book}/${spec.issue} page ${bubble.page_number})`;
    if (spec.context) {
      ({ previousText, nextText } = await readNeighbours(
        bubble,
        bookId,
        issueId,
      ));
    }
  } else if (spec.text !== undefined) {
    source = "--text";
    if (spec.context) {
      fail(
        `${where} sets --context with --text. The adjacent text comes from a page, so --context needs a --bubble source.`,
      );
    }
  } else {
    fail(
      'Nothing to render. Pass --bubble <uuid> --book <id> --issue <id>, or --text "<line>" --voice <el id>.',
    );
  }

  if (!text.trim()) fail(`No text to render (${source}).`);

  // A --bubble render always runs the render chain; --voice then replaces
  // the voice it found.
  let miss: (RenderVoice & { ok: false }) | null = null;
  let voiceId: string | null = null;
  if (spec.bubble && bookId && issueId) {
    const found = await readBubbleVoice(bookId, issueId, characterId);
    if (found.ok) voiceId = found.elevenLabsId;
    else miss = found;
  }
  voiceId = spec.voice ?? voiceId;
  if (!voiceId) fail(noVoiceMessage(speaker, bookId, issueId, miss));

  // The voice's stored override, the audio step's own read, then the flags.
  const stored: VoiceOverride =
    (
      await loadVoiceOverrides(supabase, [voiceId]).catch((e: Error) =>
        fail(e.message),
      )
    ).get(voiceId) ?? {};
  const override: VoiceOverride = { ...stored };
  const from: PlannedRender["from"] = {
    voiceId: spec.voice ? "flag" : "lookup",
    stability: stored.stability !== undefined ? "voice" : "base",
    similarityBoost: stored.similarityBoost !== undefined ? "voice" : "base",
    linePrefix: stored.linePrefix !== undefined ? "voice" : "none",
  };
  if (spec.stability !== undefined) {
    override.stability = spec.stability;
    from.stability = "flag";
  }
  if (spec.similarity !== undefined) {
    override.similarityBoost = spec.similarity;
    from.similarityBoost = "flag";
  }
  if (spec.prefix !== undefined) {
    const prefix = spec.prefix.trim();
    if (prefix) override.linePrefix = prefix;
    else delete override.linePrefix;
    from.linePrefix = "flag";
  }

  const request = buildTtsRequest({
    text,
    voiceId,
    override,
    previousText,
    nextText,
    withContext: spec.context ?? false,
  });

  return {
    label: defaultLabel(spec, index),
    voiceId,
    request,
    from,
    linePrefix: override.linePrefix ?? null,
    withContext: spec.context ?? false,
    characterCount: request.text.length,
    source,
  };
}

/** The printed request, with where each setting came from inside the JSON. */
function printableJson(render: PlannedRender): string {
  return JSON.stringify(
    {
      ...render.request,
      from: render.from,
      withContext: render.withContext,
      characterCount: render.characterCount,
    },
    null,
    2,
  );
}

function printPlan(render: PlannedRender): void {
  console.log(`\n${render.label}`);
  const { voiceSettings } = render.request;
  console.log(`   source:   ${render.source}`);
  console.log(`   voice:    ${render.voiceId} (${render.from.voiceId})`);
  console.log(`   text:     ${render.request.text}`);
  console.log(`   chars:    ${render.characterCount}`);
  console.log(
    `   settings: stability ${voiceSettings.stability} (${render.from.stability}), ` +
      `similarityBoost ${voiceSettings.similarityBoost} (${render.from.similarityBoost})`,
  );
  console.log(
    `   prefix:   ` +
      (render.linePrefix
        ? `${render.linePrefix} (${render.from.linePrefix})`
        : render.from.linePrefix === "flag"
          ? `(none, flag)`
          : `(none)`),
  );
  if (render.withContext) {
    const absent: string[] = [];
    if (render.request.previousText === undefined) absent.push("previousText");
    if (render.request.nextText === undefined) absent.push("nextText");
    console.log(
      `   context:  withContext, sending` +
        (absent.length
          ? ` nothing on this side of the bubble (${absent.join(", ")})`
          : " the adjacent bubbles"),
    );
  }
  console.log(printableJson(render));
}

/**
 * The seconds the audio runs for, read off the last character's end time. The
 * alignment is `normalizeAlignment`'s, the same shape the audio step stores.
 */
function audioDurationSeconds(
  alignment: ReturnType<typeof normalizeAlignment>,
) {
  const ends = alignment?.character_end_times_seconds ?? [];
  if (ends.length === 0) return null;
  return Number(ends[ends.length - 1]!.toFixed(3));
}

async function executeRender(render: PlannedRender): Promise<void> {
  // Under DRY_RUN the client hands back a silent mp3, so `--execute` would
  // write a file that is not a render and still print "wrote". Stop instead.
  if (isDryRun()) {
    fail(
      "DRY_RUN is set, so the client would return silent audio. Unset it to --execute for real.",
    );
  }
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
  // The call is paid for from here on, so a throw below says the audio was
  // already billed, and the mp3 is written before the json that describes it.
  const spent = "The audio was generated and ElevenLabs was charged for it.";
  const mp3Path = join(OUT_DIR, `${render.label}.mp3`);
  const jsonPath = join(OUT_DIR, `${render.label}.json`);
  let audio: Buffer | null = null;
  let alignment: ReturnType<typeof normalizeAlignment>;
  let normalizedAlignment: ReturnType<typeof normalizeAlignment>;
  try {
    audio = Buffer.from(response.audioBase64, "base64");
    alignment = normalizeAlignment(response.alignment);
    normalizedAlignment = normalizeAlignment(response.normalizedAlignment);
    await fs.ensureDir(OUT_DIR);
    await fs.writeFile(mp3Path, audio);
    await fs.writeJSON(
      jsonPath,
      {
        label: render.label,
        source: render.source,
        voiceId: render.voiceId,
        request: render.request,
        from: render.from,
        withContext: render.withContext,
        characterCount: render.characterCount,
        alignment,
        normalizedAlignment,
        audioDurationSeconds: audioDurationSeconds(alignment),
        audioBytes: audio.byteLength,
      },
      { spaces: 2 },
    );
  } catch (e) {
    fail(
      `${spent} Writing the files under tmp/render-bubble/ then failed: ${(e as Error).message}` +
        (audio ? ` The mp3 is at ${mp3Path}.` : ""),
    );
  }
  console.log(`\n   wrote ${mp3Path}`);
  console.log(`   wrote ${jsonPath}`);
}

/**
 * One batch line, held to the same rules as the flags. A jsonl line is not
 * typed, so `stability: null` and `context: "false"` would otherwise reach the
 * request; each is checked before anything is spent.
 */
function checkBatchLine(spec: LineSpec, where: string): LineSpec {
  const out: LineSpec = { ...spec };
  // A field this script no longer reads (style, speed, emotion) would
  // otherwise be dropped in silence and the line rendered without it.
  const unknown = Object.keys(out).filter(
    (k) => !(LINE_FIELDS as readonly string[]).includes(k),
  );
  if (unknown.length > 0) {
    fail(
      `${where} has ${unknown.join(", ")}, which a line cannot set. The fields are ${LINE_FIELDS.join(", ")}.`,
    );
  }
  for (const [key, range] of [
    ["stability", RANGES.stability],
    ["similarity", RANGES.similarity],
  ] as const) {
    const v = out[key];
    if (v === undefined) continue;
    if (
      typeof v !== "number" ||
      !Number.isFinite(v) ||
      v < range[0] ||
      v > range[1]
    ) {
      fail(
        `${where} has ${key}: ${JSON.stringify(v)}. It must be a number between ${range[0]} and ${range[1]}.`,
      );
    }
  }
  if (out.context !== undefined && typeof out.context !== "boolean") {
    fail(
      `${where} has context: ${JSON.stringify(out.context)}. It must be true or false.`,
    );
  }
  if (out.label !== undefined) checkLabel(out.label);
  for (const key of [
    "bubble",
    "book",
    "issue",
    "text",
    "voice",
    "prefix",
  ] as const) {
    const v = out[key];
    if (v !== undefined && typeof v !== "string") {
      fail(`${where} has ${key}: ${JSON.stringify(v)}. It must be a string.`);
    }
  }
  if (out.prefix !== undefined) checkPrefix(out.prefix, `${where} prefix`);
  return out;
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
    return checkBatchLine(parsed as LineSpec, `${path} line ${i + 1}`);
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.batch) {
    // A batch line carries every field itself, so a per-line flag beside
    // --batch would read as "and it applies to all of them" and then be
    // ignored. Say so rather than spend on lines nobody asked for.
    const perLine = LINE_FIELDS.filter((k) => args[k] !== undefined);
    if (perLine.length > 0) {
      fail(
        `--batch reads every field from ${args.batch}, so ${perLine.map((k) => `--${k}`).join(", ")} would be ignored. ` +
          `Put them on the lines instead.`,
      );
    }
    const specs = await readBatchFile(args.batch);
    if (specs.length === 0) fail(`${args.batch} has no lines.`);
    const planned: PlannedRender[] = [];
    for (const [i, spec] of specs.entries()) {
      planned.push(await planRender(spec, i, `${args.batch} line ${i + 1}`));
    }
    checkDistinctLabels(planned);
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

  const render = await planRender(args, 0, "Flags");
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

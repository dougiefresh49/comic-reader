#!/usr/bin/env node

/**
 * voice-rotation: the CLI over `src/lib/voice-slots` (#96). Plan is the
 * default for every mutating mode; `--execute` mutates ElevenLabs, the
 * `voices` rows and the `comic-voice-clips` bucket, all PRODUCTION.
 *
 *   pnpm voice-rotation -- --check
 *     ElevenLabs slot status plus the registry counts.
 *
 *   pnpm voice-rotation -- --snapshot [--voice <uuid|el_id>] [--execute]
 *     Copy each active voice's ElevenLabs sample into the bucket, md5-checked
 *     against the hash ElevenLabs reports. Free GETs; uploads and the row
 *     write need --execute.
 *
 *   pnpm voice-rotation -- --archive (--book <id> [--issue <id>] | --voice <uuid|el_id>...)
 *                          [--exclude-ids <el_id,...>|none] [--execute] [--dry-run]
 *     --book: active voices used only by that book. --issue refuses the
 *     ones that issue needs. --exclude-ids is required with --book --execute.
 *
 *   pnpm voice-rotation -- --restore (--book <id> | --voice <uuid|el_id>...) [--execute] [--dry-run]
 *
 *   pnpm voice-rotation -- --plan-free <n> --book <id> --issue <id> [--exclude-ids ...]
 *     Which voices the policy would archive so n adds fit. Plan only.
 *
 * --voice takes a voices.id or an ElevenLabs id, never a display_name
 * (decisions row 153). --dry-run still parses and adds nothing.
 */

import { supabase } from "./lib/supabase.js";
import {
  archiveVoice,
  booksUsingVoice,
  issueNeeds,
  planFreeSlots,
  readCastlist,
  readVoices,
  restoreVoice,
  slotStatus,
  snapshotSample,
  type ArchiveResult,
  type CastlistRow,
  type RestoreResult,
  type VoiceRow,
  type VoiceSlotsDeps,
} from "~/lib/voice-slots/index.js";

type Mode = "check" | "snapshot" | "archive" | "restore" | "plan-free";

interface Args {
  mode: Mode;
  book?: string;
  issue?: string;
  voices: string[];
  execute: boolean;
  excludeIdsRaw?: string;
  planFree?: number;
}

const USAGE = `
Usage:
  pnpm voice-rotation -- --check
  pnpm voice-rotation -- --snapshot [--voice <uuid|el_id>] [--execute]
  pnpm voice-rotation -- --archive (--book <id> [--issue <id>] | --voice <uuid|el_id>...) [--exclude-ids <el_id,...>|none] [--execute] [--dry-run]
  pnpm voice-rotation -- --restore (--book <id> | --voice <uuid|el_id>...) [--execute] [--dry-run]
  pnpm voice-rotation -- --plan-free <n> --book <id> --issue <id> [--exclude-ids <el_id,...>|none]

Plan is the default. Pass --execute to mutate ElevenLabs, the DB and the bucket.
--archive --book ... --execute requires --exclude-ids (use none if there are none).
`;

function die(message: string): never {
  console.error(`❌ ${message}`);
  process.exit(1);
}

function parseArgs(): Args {
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }
  const args: Args = { mode: "check", voices: [], execute: false };
  let mode: Mode | null = null;
  let dryRun = false;
  const value = (i: number, flag: string): string =>
    argv[i + 1]?.trim() || die(`${flag} needs a value`);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const [flag, inline] = a.includes("=") ? a.split(/=(.*)/s) : [a, undefined];
    const next = (): string => inline ?? value(i++, flag!);
    switch (flag) {
      case "--check":
        mode = "check";
        break;
      case "--snapshot":
        mode = "snapshot";
        break;
      case "--archive":
        mode = "archive";
        break;
      case "--restore":
        mode = "restore";
        break;
      case "--plan-free":
        mode = "plan-free";
        args.planFree = Number(next());
        break;
      case "--book":
        args.book = next();
        break;
      case "--issue":
        args.issue = next();
        break;
      case "--voice":
        args.voices.push(next());
        break;
      case "--exclude-ids":
        args.excludeIdsRaw = next();
        break;
      case "--execute":
        args.execute = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      default:
        die(`unknown flag ${a}${USAGE}`);
    }
  }
  if (!mode)
    die(
      `one of --check, --snapshot, --archive, --restore, --plan-free is required${USAGE}`,
    );
  args.mode = mode;
  if (dryRun) args.execute = false;
  if (mode === "archive" || mode === "restore") {
    if (Boolean(args.book) === args.voices.length > 0)
      die(`exactly one of --book or --voice is required for --${mode}.`);
  }
  if (mode === "plan-free") {
    if (!Number.isInteger(args.planFree) || args.planFree! < 1)
      die("--plan-free needs a positive integer");
    if (!args.book || !args.issue) die("--plan-free needs --book and --issue");
  }
  if (args.issue && !args.book) die("--issue needs --book");
  return args;
}

function parseExcludeIds(raw: string | undefined): Set<string> | undefined {
  if (raw === undefined) return undefined;
  if (raw === "none") return new Set();
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0)
    die(
      "--exclude-ids must be the literal 'none' or a non-empty comma-separated list of ElevenLabs voice ids.",
    );
  return new Set(ids);
}

/** By voices.id or ElevenLabs id; a display_name is refused (row 153). */
function selectVoices(voices: VoiceRow[], selectors: string[]): VoiceRow[] {
  return selectors.map((sel) => {
    const hit = voices.find(
      (v) => v.id === sel || v.current_elevenlabs_id === sel,
    );
    if (hit) return hit;
    const byName = voices.filter((v) => v.display_name === sel);
    if (byName.length > 0)
      die(
        `--voice ${sel} is a display_name; pass its voices.id instead (${byName.map((v) => v.id).join(", ")}).`,
      );
    return die(`--voice ${sel}: no voice has this id or ElevenLabs id.`);
  });
}

const short = (v: VoiceRow) =>
  `${v.display_name} (uuid=${v.id.slice(0, 8)}…, el=${v.current_elevenlabs_id ?? "none"})`;

const usedBy = (v: VoiceRow, castlist: CastlistRow[]) =>
  `used by: ${booksUsingVoice(v.id, castlist).join(", ") || "none"}`;

// ── Modes ─────────────────────────────────────────────────────────────────

async function runCheck(deps: VoiceSlotsDeps) {
  const [status, voices, castlist] = await Promise.all([
    slotStatus(deps),
    readVoices(deps.supabase),
    readCastlist(deps.supabase),
  ]);
  const count = (s: VoiceRow["status"]) =>
    voices.filter((v) => v.status === s).length;
  console.log(`\n🎙  Voice slots\n`);
  console.log(
    `   ElevenLabs: ${status.voice_slots_used} of ${status.voice_limit} slots used, ${status.voice_add_edit_counter} of ${status.max_voice_add_edits} add/edits used`,
  );
  console.log(
    `   Registry:   ${count("active")} active, ${count("archived")} archived, ${count("library")} library`,
  );
  const snapshotted = voices.filter(
    (v) => v.status === "active" && v.source_clip_md5,
  ).length;
  console.log(
    `   Snapshots:  ${snapshotted} of ${count("active")} active voices have a bucket copy\n`,
  );
  console.log(`   Active voices:`);
  for (const v of voices.filter((v) => v.status === "active")) {
    const flags = [
      v.keep_active ? "keep-active" : null,
      v.consumers.includes("room") ? "room" : null,
      v.source_clip_md5 ? "snapshot" : null,
    ].filter(Boolean);
    console.log(
      `     • ${v.display_name}${flags.length ? ` [${flags.join(", ")}]` : ""} ← ${v.current_elevenlabs_id ?? "(no el id)"}  ${usedBy(v, castlist)}`,
    );
  }
  console.log();
}

async function runSnapshot(deps: VoiceSlotsDeps, args: Args) {
  const voices = await readVoices(deps.supabase);
  const targets =
    args.voices.length > 0
      ? selectVoices(voices, args.voices)
      : voices.filter((v) => v.status === "active" && v.current_elevenlabs_id);
  console.log(
    `\n📸 Snapshot ${args.execute ? "EXECUTE" : "plan"}: ${targets.length} voice(s)\n`,
  );
  let ok = 0;
  for (const v of targets) {
    const r = await snapshotSample(deps, v, { execute: args.execute });
    console.log(`   • ${short(v)}`);
    for (const s of r.samples)
      console.log(
        `       ${s.fileName} ${s.bytes} bytes, md5 ${s.md5} ${s.match ? "matches" : "DIFFERS FROM"} EL hash ${s.elevenLabsHash}; bucket ${s.objectPath} ${s.alreadyStored ? "already holds it" : args.execute && r.ok ? "written" : "would be written"}`,
      );
    if (r.refusals.length > 0)
      console.log(`       refused: ${r.refusals.join("; ")}`);
    else if (r.executed)
      console.log(`       ✓ source_clip_path and source_clip_md5 written`);
    if (r.ok) ok++;
  }
  console.log(
    `\n${ok} of ${targets.length} md5-checked${args.execute ? " and stored" : "; pass --execute to upload and write the rows"}.\n`,
  );
}

function printArchive(r: ArchiveResult, castlist: CastlistRow[]) {
  const state = r.ok ? "deletable" : `refused: ${r.refusals.join(", ")}`;
  console.log(`   • ${short(r.voice)} ${usedBy(r.voice, castlist)}: ${state}`);
}

async function runArchive(deps: VoiceSlotsDeps, args: Args) {
  const excludeIds = parseExcludeIds(args.excludeIdsRaw);
  if (args.execute && args.book && excludeIds === undefined)
    die(
      "--exclude-ids is required with --archive --book --execute (use --exclude-ids none if there are none).",
    );
  const [voices, castlist] = await Promise.all([
    readVoices(deps.supabase),
    readCastlist(deps.supabase),
  ]);
  if (excludeIds && excludeIds.size > 0) {
    const known = new Set(voices.map((v) => v.current_elevenlabs_id));
    const unmatched = [...excludeIds].filter((id) => !known.has(id));
    for (const id of unmatched)
      console.warn(
        `⚠ --exclude-ids ${id}: no voice has this current_elevenlabs_id`,
      );
    if (unmatched.length > 0 && args.execute)
      die(
        "--exclude-ids includes id(s) that match no voice; refusing to execute.",
      );
  }

  const candidates = args.book
    ? voices.filter((v) => {
        if (v.status !== "active" || !v.current_elevenlabs_id) return false;
        const books = booksUsingVoice(v.id, castlist);
        return books.length > 0 && books.every((b) => b === args.book);
      })
    : selectVoices(voices, args.voices);
  const target =
    args.book && args.issue
      ? { bookId: args.book, issueId: args.issue }
      : undefined;
  const needs = target ? await issueNeeds(deps.supabase, target) : undefined;
  const guard = { needs, excludeIds, archivedForBookId: args.book };

  const scope = args.book
    ? `for book "${args.book}"${args.issue ? `, keeping what ${args.issue} needs` : ""}`
    : `for --voice ${args.voices.join(", ")}`;
  console.log(`\n📦 Archive plan ${scope}: ${candidates.length} considered\n`);
  const plans: ArchiveResult[] = [];
  for (const v of candidates) {
    const r = await archiveVoice(deps, v, guard);
    printArchive(r, castlist);
    plans.push(r);
  }
  const deletable = plans.filter((p) => p.ok);
  console.log(
    `\n${deletable.length} deletable of ${candidates.length} considered\n`,
  );
  if (!args.execute) return;
  if (deletable.length === 0) {
    console.log(`   Nothing deletable, not touching EL or DB.\n`);
    return;
  }
  let archived = 0;
  for (const p of deletable) {
    console.log(`   Archiving ${short(p.voice)}...`);
    const r = await archiveVoice(deps, p.voice, { ...guard, execute: true });
    if (!r.executed) {
      console.log(`   ✗ refused on recheck: ${r.refusals.join(", ")}`);
      continue;
    }
    console.log(
      `   ✓ archived${r.alreadyGone ? " (EL already had no such voice)" : ""}`,
    );
    archived++;
  }
  console.log(`\n✅ Archived ${archived} voice(s).\n`);
}

function printRestore(r: RestoreResult, castlist: CastlistRow[]) {
  const state = r.ok ? "restorable" : `refused: ${r.refusals.join(", ")}`;
  const warn = r.warnings.length ? ` (${r.warnings.join("; ")})` : "";
  console.log(
    `   • ${short(r.voice)} ${usedBy(r.voice, castlist)}: ${state}${warn}`,
  );
}

async function runRestore(deps: VoiceSlotsDeps, args: Args) {
  const [voices, castlist] = await Promise.all([
    readVoices(deps.supabase),
    readCastlist(deps.supabase),
  ]);
  const candidates = args.book
    ? voices.filter(
        (v) =>
          v.status === "archived" &&
          castlist.some(
            (c) => c.book_id === args.book && c.voice_uuid === v.id,
          ),
      )
    : selectVoices(voices, args.voices);
  const scope = args.book
    ? `for book "${args.book}"`
    : `for --voice ${args.voices.join(", ")}`;
  console.log(`\n📂 Restore plan ${scope}: ${candidates.length} considered\n`);
  if (candidates.length === 0) {
    console.log(`   Nothing to restore.\n`);
    return;
  }
  const plans: RestoreResult[] = [];
  for (const v of candidates) {
    const r = await restoreVoice(deps, v);
    printRestore(r, castlist);
    plans.push(r);
  }
  const restorable = plans.filter((p) => p.ok);
  console.log(
    `\n${restorable.length} restorable of ${candidates.length} considered\n`,
  );
  if (!args.execute) return;
  if (restorable.length === 0) {
    console.log(`   Nothing restorable, not touching EL or DB.\n`);
    return;
  }
  let restored = 0;
  for (const p of restorable) {
    console.log(`   Restoring ${short(p.voice)}...`);
    const r = await restoreVoice(deps, p.voice, { execute: true });
    if (!r.executed) {
      console.log(`   ✗ refused on recheck: ${r.refusals.join(", ")}`);
      continue;
    }
    console.log(`   ✓ new el id: ${r.newElevenLabsId}`);
    restored++;
  }
  console.log(`\n✅ Restored ${restored}.\n`);
}

async function runPlanFree(deps: VoiceSlotsDeps, args: Args) {
  const n = args.planFree!;
  const plan = await planFreeSlots(deps, n, {
    bookId: args.book!,
    issueId: args.issue!,
    excludeIds: parseExcludeIds(args.excludeIdsRaw),
  });
  const castlist = await readCastlist(deps.supabase);
  const s = plan.status;
  console.log(
    `\n🧮 Free ${n} slot(s) for ${args.book}/${args.issue} (plan only)\n`,
  );
  console.log(
    `   ElevenLabs: ${s.voice_slots_used} of ${s.voice_limit} slots used (${plan.freeNow} free), add/edit headroom ${plan.addEditHeadroom}`,
  );
  console.log(`   To archive: ${plan.toArchive}\n`);
  if (plan.pick.length) {
    console.log(`   Would archive, in policy order:`);
    for (const v of plan.pick)
      console.log(
        `     • ${short(v)} ${usedBy(v, castlist)}${v.design_prompt ? " [generated]" : ""}`,
      );
  }
  if (plan.spare.length) {
    console.log(`   Eligible but not needed (bucket copy unchecked):`);
    for (const v of plan.spare)
      console.log(`     • ${short(v)} ${usedBy(v, castlist)}`);
  }
  if (plan.refused.length) {
    console.log(`   Refused:`);
    for (const r of plan.refused)
      console.log(`     • ${short(r.voice)}: ${r.refusals.join(", ")}`);
  }
  console.log(
    `\n${plan.ok ? "✅ Plan fits." : `❌ Plan refused: ${plan.refusals.join("; ")}`}\n`,
  );
}

async function main() {
  const args = parseArgs();
  const deps: VoiceSlotsDeps = { supabase };
  if (args.mode === "check") await runCheck(deps);
  else if (args.mode === "snapshot") await runSnapshot(deps, args);
  else if (args.mode === "archive") await runArchive(deps, args);
  else if (args.mode === "restore") await runRestore(deps, args);
  else await runPlanFree(deps, args);
}

main().catch((err) => {
  console.error("❌ voice-rotation:", err instanceof Error ? err.message : err);
  process.exit(1);
});

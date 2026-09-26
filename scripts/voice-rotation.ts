#!/usr/bin/env node

/**
 * voice-rotation: keep the active ElevenLabs voice count below the cap
 * by archiving voices we don't currently need, and restoring them on
 * demand. Schema: see supabase/migrations/20260501_voice_rotation.sql.
 *
 * Three modes:
 *
 *   pnpm voice-rotation -- --check
 *     Report current active/archived/library counts and which books
 *     each active voice is used by.
 *
 *   pnpm voice-rotation -- --archive (--book <id> | --voice <id|name>...)
 *     Plan (default): list which active voices would be deleted, and why
 *     others are skipped. Pass --execute to actually DELETE on ElevenLabs
 *     and update the DB. A voice is deletable only when it is active,
 *     keep_active=false, not excluded, and has a source_clip_path whose
 *     Storage object exists.
 *
 *   pnpm voice-rotation -- --restore (--book <id> | --voice <id|name>...)
 *     Plan (default): list archived voices that would be restored.
 *     Pass --execute to re-add from source_clip_path.
 *
 * --dry-run still parses for back-compat and does nothing extra (plan is
 * already the default). --exclude-ids is required with
 * --archive --book --execute; use --exclude-ids none when empty.
 *
 * Per the 2026-05-01 fidelity test outcome (indistinguishable), the
 * default keep_active is `false`. Every voice gets rotated unless
 * manually flagged. Set `keep_active = true` for main-cast voices only
 * if you want to skip the recreation cost on every ingest.
 */

import { pathToFileURL } from "node:url";
import { supabase } from "./lib/supabase.js";

const ELEVENLABS_API_BASE = "https://api.elevenlabs.io";

export interface VoiceRow {
  id: string;
  display_name: string;
  series_id: string | null;
  status: "active" | "archived" | "library";
  current_elevenlabs_id: string | null;
  voice_settings: Record<string, unknown> | null;
  source_clip_path: string | null;
  design_prompt: string | null;
  keep_active: boolean;
  created_at: string;
  archived_at: string | null;
}

export interface CastlistRow {
  book_id: string;
  issue_id: string;
  character: string;
  voice_id: string | null;
  voice_uuid: string | null;
}

export type ClipExistsFn = (sourceClipPath: string) => Promise<boolean>;

export interface PlanArchiveOpts {
  /** Scope to voices used only by this book. Mutually exclusive with voiceSelectors. */
  book?: string;
  /** Scope to named voices (uuid or display_name). Mutually exclusive with book. */
  voiceSelectors?: string[];
  /**
   * ElevenLabs voice ids to leave alone. Empty set means none excluded
   * (from `--exclude-ids none` only). Undefined means the flag was not
   * passed, so nothing is filtered by exclude.
   */
  excludeIds?: Set<string>;
  clipExists: ClipExistsFn;
}

export interface ArchiveSkip {
  voice: VoiceRow;
  reason: string;
}

export interface ArchivePlan {
  deletable: VoiceRow[];
  skipped: ArchiveSkip[];
}

interface Args {
  mode: "check" | "archive" | "restore";
  book?: string;
  voices: string[];
  dryRun: boolean;
  execute: boolean;
  excludeIdsRaw: string | undefined;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`
Usage:
  pnpm voice-rotation -- --check
  pnpm voice-rotation -- --archive (--book <id> | --voice <uuid|name>...) [--exclude-ids <el_id,...>|none] [--execute] [--dry-run]
  pnpm voice-rotation -- --restore (--book <id> | --voice <uuid|name>...) [--execute] [--dry-run]

Plan is the default for --archive and --restore. Pass --execute to mutate.
--dry-run still parses and does nothing extra.
--archive --book … --execute requires --exclude-ids (use none if empty).
`);
    process.exit(0);
  }
  let mode: Args["mode"] | null = null;
  let book: string | undefined;
  const voices: string[] = [];
  let dryRun = false;
  let execute = false;
  let excludeIdsRaw: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a === "--check") mode = "check";
    else if (a === "--archive") mode = "archive";
    else if (a === "--restore") mode = "restore";
    else if (a === "--book") book = argv[++i]?.trim();
    else if (a.startsWith("--book=")) book = a.split("=")[1]?.trim();
    else if (a === "--voice") {
      const v = argv[++i]?.trim();
      if (v) voices.push(v);
    } else if (a.startsWith("--voice=")) {
      const v = a.split("=")[1]?.trim();
      if (v) voices.push(v);
    } else if (a === "--exclude-ids") excludeIdsRaw = argv[++i]?.trim();
    else if (a.startsWith("--exclude-ids="))
      excludeIdsRaw = a.split("=")[1]?.trim();
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--execute") execute = true;
  }
  if (!mode) {
    console.error("❌ One of --check, --archive, --restore is required.");
    process.exit(1);
  }
  if (mode === "archive" || mode === "restore") {
    const hasBook = Boolean(book);
    const hasVoice = voices.length > 0;
    if (hasBook === hasVoice) {
      console.error(
        `❌ Exactly one of --book or --voice is required for --${mode}.`,
      );
      process.exit(1);
    }
  }
  return { mode, book, voices, dryRun, execute, excludeIdsRaw };
}

function parseExcludeIds(raw: string | undefined): Set<string> | undefined {
  if (raw === undefined) return undefined;
  if (raw === "none") return new Set();
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    console.error(
      "❌ --exclude-ids must be the literal 'none' or a non-empty comma-separated list of ElevenLabs voice ids.",
    );
    process.exit(1);
  }
  return new Set(ids);
}

async function fetchAllVoices(): Promise<VoiceRow[]> {
  const { data, error } = await supabase.from("voices").select("*");
  if (error) throw new Error(`fetch voices: ${error.message}`);
  return (data ?? []) as VoiceRow[];
}

async function fetchCastlist(): Promise<CastlistRow[]> {
  const { data, error } = await supabase.from("castlist").select("*");
  if (error) throw new Error(`fetch castlist: ${error.message}`);
  return (data ?? []) as CastlistRow[];
}

function booksUsingVoice(voiceUuid: string, castlist: CastlistRow[]): string[] {
  const books = new Set<string>();
  for (const c of castlist)
    if (c.voice_uuid === voiceUuid) books.add(c.book_id);
  return [...books].sort();
}

function parseClipStoragePath(storagePath: string): {
  bucket: string;
  objectPath: string;
} {
  // source_clip_path is "<bucket>/<path>" or just "<path>" within comic-voice-clips.
  const [maybeBucket, ...rest] = storagePath.split("/");
  const bucket = rest.length > 0 ? maybeBucket! : "comic-voice-clips";
  const objectPath = rest.length > 0 ? rest.join("/") : storagePath;
  return { bucket, objectPath };
}

/** Read-only Storage existence check (list, not download). */
export async function clipExistsInStorage(
  storagePath: string,
): Promise<boolean> {
  const { bucket, objectPath } = parseClipStoragePath(storagePath);
  const lastSlash = objectPath.lastIndexOf("/");
  const folder = lastSlash >= 0 ? objectPath.slice(0, lastSlash) : "";
  const filename =
    lastSlash >= 0 ? objectPath.slice(lastSlash + 1) : objectPath;
  const { data, error } = await supabase.storage.from(bucket).list(folder, {
    limit: 100,
    search: filename,
  });
  if (error) return false;
  // Folders appear as list entries with id: null; only real objects count.
  return (data ?? []).some(
    (entry) => entry.name === filename && entry.id !== null,
  );
}

function voiceMatchesSelector(voice: VoiceRow, selector: string): boolean {
  return voice.id === selector || voice.display_name === selector;
}

function selectArchiveCandidates(
  voices: VoiceRow[],
  castlist: CastlistRow[],
  opts: Pick<PlanArchiveOpts, "book" | "voiceSelectors">,
): VoiceRow[] {
  if (opts.book) {
    const book = opts.book;
    return voices.filter((v) => {
      if (v.status !== "active") return false;
      if (!v.current_elevenlabs_id) return false;
      const books = booksUsingVoice(v.id, castlist);
      return books.length > 0 && books.every((b) => b === book);
    });
  }
  const selectors = opts.voiceSelectors ?? [];
  return voices.filter((v) => {
    if (v.status !== "active") return false;
    if (!v.current_elevenlabs_id) return false;
    return selectors.some((s) => voiceMatchesSelector(v, s));
  });
}

/**
 * Pure archive planner. Storage existence is injected so fixtures can stub it.
 * design_prompt alone is not a restore source (issue #66 decision 1).
 */
export async function planArchive(
  voices: VoiceRow[],
  castlist: CastlistRow[],
  opts: PlanArchiveOpts,
): Promise<ArchivePlan> {
  const candidates = selectArchiveCandidates(voices, castlist, opts);
  const deletable: VoiceRow[] = [];
  const skipped: ArchiveSkip[] = [];

  for (const voice of candidates) {
    if (voice.keep_active) {
      skipped.push({ voice, reason: "keep_active" });
      continue;
    }
    if (
      opts.excludeIds &&
      voice.current_elevenlabs_id &&
      opts.excludeIds.has(voice.current_elevenlabs_id)
    ) {
      skipped.push({ voice, reason: "excluded" });
      continue;
    }
    if (!voice.source_clip_path) {
      skipped.push({ voice, reason: "no source_clip_path" });
      continue;
    }
    const exists = await opts.clipExists(voice.source_clip_path);
    if (!exists) {
      skipped.push({ voice, reason: "source_clip_path missing in storage" });
      continue;
    }
    deletable.push(voice);
  }

  return { deletable, skipped };
}

function requireApiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    console.error("❌ ELEVENLABS_API_KEY not set.");
    process.exit(1);
  }
  return key;
}

async function el(
  path: string,
  apiKey: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${ELEVENLABS_API_BASE}${path}`, {
    ...init,
    headers: { "xi-api-key": apiKey, ...(init?.headers ?? {}) },
  });
}

async function deleteElevenLabsVoice(
  elId: string,
  apiKey: string,
): Promise<void> {
  const r = await el(`/v1/voices/${elId}`, apiKey, { method: "DELETE" });
  if (!r.ok) {
    const text = await r.text();
    // 404 from EL means the voice is already gone. Treat as success.
    if (r.status === 404) {
      console.warn(`   ℹ ${elId} already gone on EL (404), proceeding`);
      return;
    }
    throw new Error(
      `DELETE /v1/voices/${elId} → ${r.status}: ${text.slice(0, 200)}`,
    );
  }
}

interface CreateIVCResult {
  voice_id: string;
}

async function createElevenLabsIVC(
  name: string,
  clipBytes: ArrayBuffer,
  filename: string,
  apiKey: string,
): Promise<CreateIVCResult> {
  const form = new FormData();
  form.append("name", name);
  form.append("files", new Blob([clipBytes], { type: "audio/mpeg" }), filename);
  const r = await fetch(`${ELEVENLABS_API_BASE}/v1/voices/add`, {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`POST /v1/voices/add → ${r.status}: ${t.slice(0, 200)}`);
  }
  return (await r.json()) as CreateIVCResult;
}

async function downloadClip(storagePath: string): Promise<ArrayBuffer> {
  const { bucket, objectPath } = parseClipStoragePath(storagePath);
  const { data, error } = await supabase.storage
    .from(bucket)
    .download(objectPath);
  if (error || !data) {
    throw new Error(
      `download ${bucket}/${objectPath}: ${error?.message ?? "no data"}`,
    );
  }
  return data.arrayBuffer();
}

// ── Modes ─────────────────────────────────────────────────────────────────

async function runCheck() {
  const [voices, castlist] = await Promise.all([
    fetchAllVoices(),
    fetchCastlist(),
  ]);
  const byStatus = { active: 0, archived: 0, library: 0 };
  for (const v of voices) byStatus[v.status]++;

  console.log(`\n🎙  Voice rotation status\n`);
  console.log(`   Active:   ${byStatus.active} (counts toward EL cap)`);
  console.log(`   Archived: ${byStatus.archived}`);
  console.log(`   Library:  ${byStatus.library} (no slot used)\n`);

  const active = voices.filter((v) => v.status === "active");
  if (active.length === 0) return;

  console.log(`   Active voices and their books:`);
  for (const v of active) {
    const books = booksUsingVoice(v.id, castlist);
    const flag = v.keep_active ? " [keep-active]" : "";
    console.log(
      `     • ${v.display_name}${flag} ← ${v.current_elevenlabs_id ?? "(no el id)"}  used by: ${books.join(", ") || "none"}`,
    );
  }
  console.log();
}

function printArchivePlan(
  plan: ArchivePlan,
  castlist: CastlistRow[],
  scopeLabel: string,
  showBooks: boolean,
) {
  const considered = plan.deletable.length + plan.skipped.length;
  console.log(`\n📦 Archive plan ${scopeLabel}: ${considered} considered\n`);

  for (const { voice, reason } of plan.skipped) {
    const books = showBooks
      ? ` used by: ${booksUsingVoice(voice.id, castlist).join(", ") || "none"}`
      : "";
    console.log(
      `   • ${voice.display_name} (uuid=${voice.id.slice(0, 8)}…, el=${voice.current_elevenlabs_id})${books}: skipped, ${reason}`,
    );
  }
  for (const voice of plan.deletable) {
    const books = showBooks
      ? ` used by: ${booksUsingVoice(voice.id, castlist).join(", ") || "none"}`
      : "";
    console.log(
      `   • ${voice.display_name} (uuid=${voice.id.slice(0, 8)}…, el=${voice.current_elevenlabs_id})${books}: deletable`,
    );
  }

  console.log(
    `\n${plan.deletable.length} deletable of ${considered} considered\n`,
  );
}

async function runArchive(args: Args) {
  const excludeIds = parseExcludeIds(args.excludeIdsRaw);
  const shouldExecute = args.execute && !args.dryRun;

  if (shouldExecute && args.book && excludeIds === undefined) {
    console.error(
      "❌ --exclude-ids is required with --archive --book --execute (use --exclude-ids none if there are none).",
    );
    process.exit(1);
  }

  const [voices, castlist] = await Promise.all([
    fetchAllVoices(),
    fetchCastlist(),
  ]);

  if (args.voices.length > 0) {
    for (const sel of args.voices) {
      if (!voices.some((v) => voiceMatchesSelector(v, sel))) {
        console.error(`❌ --voice ${sel}: no matching voice.`);
        process.exit(1);
      }
    }
  }

  if (excludeIds && excludeIds.size > 0) {
    const knownElIds = new Set(
      voices
        .map((v) => v.current_elevenlabs_id)
        .filter((id): id is string => Boolean(id)),
    );
    const unmatched = [...excludeIds].filter((id) => !knownElIds.has(id));
    for (const id of unmatched) {
      console.warn(
        `⚠ --exclude-ids ${id}: no voice has this current_elevenlabs_id`,
      );
    }
    if (unmatched.length > 0 && shouldExecute) {
      console.error(
        "❌ --exclude-ids includes id(s) that match no voice; refusing to execute.",
      );
      process.exit(1);
    }
  }

  const plan = await planArchive(voices, castlist, {
    book: args.book,
    voiceSelectors: args.voices.length > 0 ? args.voices : undefined,
    excludeIds,
    clipExists: clipExistsInStorage,
  });

  const scopeLabel = args.book
    ? `for book "${args.book}"`
    : `for --voice ${args.voices.join(", ")}`;
  printArchivePlan(plan, castlist, scopeLabel, args.voices.length > 0);

  if (!shouldExecute) {
    if (args.dryRun) console.log(`   --dry-run: not touching EL or DB.\n`);
    return;
  }

  if (plan.deletable.length === 0) {
    console.log(`   Nothing deletable, not touching EL or DB.\n`);
    return;
  }

  const apiKey = requireApiKey();

  for (const v of plan.deletable) {
    const elId = v.current_elevenlabs_id!;
    const bookForLog =
      args.book ?? booksUsingVoice(v.id, castlist)[0] ?? "unknown";
    console.log(`\n   Archiving ${v.display_name} (${elId})...`);
    await deleteElevenLabsVoice(elId, apiKey);

    const archivedAt = new Date().toISOString();
    const updates = await supabase
      .from("voices")
      .update({
        status: "archived",
        current_elevenlabs_id: null,
        archived_at: archivedAt,
      })
      .eq("id", v.id);
    if (updates.error)
      throw new Error(`update voices: ${updates.error.message}`);

    const castUpdate = await supabase
      .from("castlist")
      .update({ voice_id: null })
      .eq("voice_uuid", v.id);
    if (castUpdate.error)
      throw new Error(`update castlist: ${castUpdate.error.message}`);

    const archiveLog = await supabase.from("voice_archives").insert({
      voice_id: v.id,
      former_elevenlabs_id: elId,
      archived_for_book_id: bookForLog,
    });
    if (archiveLog.error)
      throw new Error(`insert voice_archives: ${archiveLog.error.message}`);

    console.log(`   ✓ archived`);
  }
  console.log(`\n✅ Archived ${plan.deletable.length} voice(s).\n`);
}

interface RestoreSkip {
  voice: VoiceRow;
  reason: string;
}

interface RestorePlan {
  restorable: VoiceRow[];
  skipped: RestoreSkip[];
}

function selectRestoreCandidates(
  voices: VoiceRow[],
  castlist: CastlistRow[],
  opts: { book?: string; voiceSelectors?: string[] },
): VoiceRow[] {
  if (opts.book) {
    const neededUuids = new Set(
      castlist
        .filter((c) => c.book_id === opts.book && c.voice_uuid)
        .map((c) => c.voice_uuid!),
    );
    return voices.filter(
      (v) => neededUuids.has(v.id) && v.status === "archived",
    );
  }
  const selectors = opts.voiceSelectors ?? [];
  return voices.filter(
    (v) =>
      v.status === "archived" &&
      selectors.some((s) => voiceMatchesSelector(v, s)),
  );
}

async function planRestore(
  voices: VoiceRow[],
  castlist: CastlistRow[],
  opts: {
    book?: string;
    voiceSelectors?: string[];
    clipExists: ClipExistsFn;
  },
): Promise<RestorePlan> {
  const candidates = selectRestoreCandidates(voices, castlist, opts);
  const restorable: VoiceRow[] = [];
  const skipped: RestoreSkip[] = [];

  for (const voice of candidates) {
    if (!voice.source_clip_path) {
      skipped.push({ voice, reason: "no source_clip_path" });
      continue;
    }
    const exists = await opts.clipExists(voice.source_clip_path);
    if (!exists) {
      skipped.push({ voice, reason: "source_clip_path missing in storage" });
      continue;
    }
    restorable.push(voice);
  }
  return { restorable, skipped };
}

function printRestorePlan(
  plan: RestorePlan,
  castlist: CastlistRow[],
  scopeLabel: string,
  showBooks: boolean,
) {
  const considered = plan.restorable.length + plan.skipped.length;
  console.log(`\n📂 Restore plan ${scopeLabel}: ${considered} considered\n`);

  if (considered === 0) {
    console.log(`   Nothing to restore, all needed voices already active.\n`);
    return;
  }

  for (const { voice, reason } of plan.skipped) {
    const books = showBooks
      ? ` used by: ${booksUsingVoice(voice.id, castlist).join(", ") || "none"}`
      : "";
    console.log(
      `   • ${voice.display_name} (uuid=${voice.id.slice(0, 8)}…)${books}: skipped, ${reason}`,
    );
  }
  for (const voice of plan.restorable) {
    const books = showBooks
      ? ` used by: ${booksUsingVoice(voice.id, castlist).join(", ") || "none"}`
      : "";
    console.log(
      `   • ${voice.display_name} (uuid=${voice.id.slice(0, 8)}…)${books}: restorable`,
    );
  }

  console.log(
    `\n${plan.restorable.length} restorable of ${considered} considered\n`,
  );
}

async function runRestore(args: Args) {
  const shouldExecute = args.execute && !args.dryRun;

  const [voices, castlist] = await Promise.all([
    fetchAllVoices(),
    fetchCastlist(),
  ]);

  if (args.voices.length > 0) {
    for (const sel of args.voices) {
      if (!voices.some((v) => voiceMatchesSelector(v, sel))) {
        console.error(`❌ --voice ${sel}: no matching voice.`);
        process.exit(1);
      }
    }
  }

  const plan = await planRestore(voices, castlist, {
    book: args.book,
    voiceSelectors: args.voices.length > 0 ? args.voices : undefined,
    clipExists: clipExistsInStorage,
  });

  const scopeLabel = args.book
    ? `for book "${args.book}"`
    : `for --voice ${args.voices.join(", ")}`;
  printRestorePlan(plan, castlist, scopeLabel, args.voices.length > 0);

  if (!shouldExecute) {
    if (args.dryRun) console.log(`   --dry-run: not touching EL or DB.\n`);
    return;
  }

  if (plan.restorable.length === 0) {
    console.log(`   Nothing restorable, not touching EL or DB.\n`);
    return;
  }

  const apiKey = requireApiKey();
  let restored = 0;
  for (const v of plan.restorable) {
    console.log(`\n   Restoring ${v.display_name}...`);
    const clip = await downloadClip(v.source_clip_path!);
    const filename = v.source_clip_path!.split("/").pop() || `${v.id}.mp3`;
    const created = await createElevenLabsIVC(
      v.display_name,
      clip,
      filename,
      apiKey,
    );
    console.log(`   ✓ new el id: ${created.voice_id}`);

    const upd = await supabase
      .from("voices")
      .update({
        status: "active",
        current_elevenlabs_id: created.voice_id,
        archived_at: null,
      })
      .eq("id", v.id);
    if (upd.error) throw new Error(`update voices: ${upd.error.message}`);

    const castUpd = await supabase
      .from("castlist")
      .update({ voice_id: created.voice_id })
      .eq("voice_uuid", v.id);
    if (castUpd.error)
      throw new Error(`update castlist: ${castUpd.error.message}`);
    restored++;
  }
  console.log(`\n✅ Restored ${restored}.\n`);
}

async function main() {
  const args = parseArgs();
  if (args.mode === "check") await runCheck();
  else if (args.mode === "archive") await runArchive(args);
  else await runRestore(args);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return (
      entry.endsWith("voice-rotation.ts") || entry.endsWith("voice-rotation.js")
    );
  }
}

if (isMainModule()) {
  main().catch((err) => {
    console.error("❌ voice-rotation:", err);
    process.exit(1);
  });
}

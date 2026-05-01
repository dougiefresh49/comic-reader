#!/usr/bin/env node

/**
 * voice-rotation — keep the active ElevenLabs voice count below the cap
 * by archiving voices we don't currently need, and restoring them on
 * demand. Schema: see supabase/migrations/20260501_voice_rotation.sql.
 *
 * Three modes:
 *
 *   pnpm voice-rotation -- --check
 *     Report current active/archived/library counts and which books
 *     each active voice is used by.
 *
 *   pnpm voice-rotation -- --archive --book <id> [--dry-run]
 *     Archive every voice used ONLY by book X where keep_active=false:
 *       1. DELETE /v1/voices/{el_id}
 *       2. UPDATE voices SET status='archived', current_elevenlabs_id=null
 *       3. UPDATE castlist SET voice_id=null WHERE voice_uuid=this
 *       4. INSERT into voice_archives (audit log)
 *
 *   pnpm voice-rotation -- --restore --book <id> [--dry-run]
 *     Restore every archived voice that's referenced by book X's castlist:
 *       1. Fetch source_clip_path from Supabase Storage
 *       2. POST /v1/voices/add with the clip → new el_id
 *       3. UPDATE voices SET status='active', current_elevenlabs_id=new_id
 *       4. UPDATE castlist SET voice_id=new_id WHERE voice_uuid=this
 *
 * --dry-run shows what would happen without touching ElevenLabs or the DB.
 *
 * Per the 2026-05-01 fidelity test outcome (indistinguishable), the
 * default keep_active is `false` — every voice gets rotated unless
 * manually flagged. Set `keep_active = true` for main-cast voices only
 * if you want to skip the recreation cost on every ingest.
 */

import { supabase } from "./lib/supabase.js";

const ELEVENLABS_API_BASE = "https://api.elevenlabs.io";

const apiKey = process.env.ELEVENLABS_API_KEY;
if (!apiKey) {
  console.error("❌ ELEVENLABS_API_KEY not set.");
  process.exit(1);
}

interface Args {
  mode: "check" | "archive" | "restore";
  book?: string;
  dryRun: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`
Usage:
  pnpm voice-rotation -- --check
  pnpm voice-rotation -- --archive --book <id> [--dry-run]
  pnpm voice-rotation -- --restore --book <id> [--dry-run]
`);
    process.exit(0);
  }
  let mode: Args["mode"] | null = null;
  let book: string | undefined;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a === "--check") mode = "check";
    else if (a === "--archive") mode = "archive";
    else if (a === "--restore") mode = "restore";
    else if (a === "--book") book = argv[i + 1]?.trim();
    else if (a.startsWith("--book=")) book = a.split("=")[1]?.trim();
    else if (a === "--dry-run") dryRun = true;
  }
  if (!mode) {
    console.error("❌ One of --check, --archive, --restore is required.");
    process.exit(1);
  }
  if ((mode === "archive" || mode === "restore") && !book) {
    console.error(`❌ --book required for --${mode}.`);
    process.exit(1);
  }
  return { mode, book, dryRun };
}

interface VoiceRow {
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

async function fetchAllVoices(): Promise<VoiceRow[]> {
  const { data, error } = await supabase.from("voices").select("*");
  if (error) throw new Error(`fetch voices: ${error.message}`);
  return (data ?? []) as VoiceRow[];
}

interface CastlistRow {
  book_id: string;
  issue_id: string;
  character: string;
  voice_id: string | null;
  voice_uuid: string | null;
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

async function el(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${ELEVENLABS_API_BASE}${path}`, {
    ...init,
    headers: { "xi-api-key": apiKey!, ...(init?.headers ?? {}) },
  });
}

async function deleteElevenLabsVoice(elId: string): Promise<void> {
  const r = await el(`/v1/voices/${elId}`, { method: "DELETE" });
  if (!r.ok) {
    const text = await r.text();
    // 404 from EL means the voice is already gone — treat as success.
    if (r.status === 404) {
      console.warn(`   ℹ ${elId} already gone on EL (404) — proceeding`);
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
): Promise<CreateIVCResult> {
  const form = new FormData();
  form.append("name", name);
  form.append("files", new Blob([clipBytes], { type: "audio/mpeg" }), filename);
  const r = await fetch(`${ELEVENLABS_API_BASE}/v1/voices/add`, {
    method: "POST",
    headers: { "xi-api-key": apiKey! },
    body: form,
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`POST /v1/voices/add → ${r.status}: ${t.slice(0, 200)}`);
  }
  return (await r.json()) as CreateIVCResult;
}

async function downloadClip(storagePath: string): Promise<ArrayBuffer> {
  // source_clip_path is "<bucket>/<path>" or just "<path>" within comic-voice-clips.
  const [maybeBucket, ...rest] = storagePath.split("/");
  const bucket = rest.length > 0 ? maybeBucket! : "comic-voice-clips";
  const objectPath = rest.length > 0 ? rest.join("/") : storagePath;
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

async function runArchive(book: string, dryRun: boolean) {
  const [voices, castlist] = await Promise.all([
    fetchAllVoices(),
    fetchCastlist(),
  ]);

  // Candidate: status=active, keep_active=false, used ONLY by `book`.
  const candidates = voices.filter((v) => {
    if (v.status !== "active") return false;
    if (v.keep_active) return false;
    if (!v.current_elevenlabs_id) return false;
    const books = booksUsingVoice(v.id, castlist);
    return books.length > 0 && books.every((b) => b === book);
  });

  console.log(
    `\n📦 Archive plan for book "${book}": ${candidates.length} voice(s)\n`,
  );
  if (candidates.length === 0) {
    console.log(`   Nothing to archive.\n`);
    return;
  }
  for (const v of candidates) {
    console.log(
      `   • ${v.display_name} (uuid=${v.id.slice(0, 8)}…, el=${v.current_elevenlabs_id})`,
    );
  }
  if (dryRun) {
    console.log(`\n   --dry-run: not touching EL or DB.\n`);
    return;
  }

  for (const v of candidates) {
    const elId = v.current_elevenlabs_id!;
    console.log(`\n   Archiving ${v.display_name} (${elId})...`);
    await deleteElevenLabsVoice(elId);

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
      archived_for_book_id: book,
    });
    if (archiveLog.error)
      throw new Error(`insert voice_archives: ${archiveLog.error.message}`);

    console.log(`   ✓ archived`);
  }
  console.log(`\n✅ Archived ${candidates.length} voice(s).\n`);
}

async function runRestore(book: string, dryRun: boolean) {
  const [voices, castlist] = await Promise.all([
    fetchAllVoices(),
    fetchCastlist(),
  ]);

  const neededUuids = new Set(
    castlist
      .filter((c) => c.book_id === book && c.voice_uuid)
      .map((c) => c.voice_uuid!),
  );

  const archived = voices.filter(
    (v) => neededUuids.has(v.id) && v.status === "archived",
  );

  console.log(
    `\n📂 Restore plan for book "${book}": ${archived.length} voice(s)\n`,
  );
  if (archived.length === 0) {
    console.log(`   Nothing to restore — all needed voices already active.\n`);
    return;
  }
  for (const v of archived) {
    const hasClip = v.source_clip_path ? "" : " ⚠ no source_clip_path";
    console.log(`   • ${v.display_name} (uuid=${v.id.slice(0, 8)}…)${hasClip}`);
  }
  if (dryRun) {
    console.log(`\n   --dry-run: not touching EL or DB.\n`);
    return;
  }

  let restored = 0;
  let skipped = 0;
  for (const v of archived) {
    if (!v.source_clip_path) {
      console.log(
        `   ⚠ skipping ${v.display_name}: no source_clip_path (rerun backfill or re-source).`,
      );
      skipped++;
      continue;
    }
    console.log(`\n   Restoring ${v.display_name}...`);
    const clip = await downloadClip(v.source_clip_path);
    const filename = v.source_clip_path.split("/").pop() || `${v.id}.mp3`;
    const created = await createElevenLabsIVC(v.display_name, clip, filename);
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
  console.log(
    `\n✅ Restored ${restored}${skipped > 0 ? ` (skipped ${skipped})` : ""}.\n`,
  );
}

async function main() {
  const { mode, book, dryRun } = parseArgs();
  if (mode === "check") await runCheck();
  else if (mode === "archive") await runArchive(book!, dryRun);
  else await runRestore(book!, dryRun);
}

main().catch((err) => {
  console.error("❌ voice-rotation:", err);
  process.exit(1);
});

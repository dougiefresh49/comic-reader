#!/usr/bin/env node

/**
 * Fill the `voices` registry from a voice-lab handoff (#91).
 *
 * For --book tmnt-x-mmpr it reads the lab's ElevenLabs snapshot and fills
 * description and labels on existing rows (matched on
 * current_elevenlabs_id), plus design_prompt for generated voices where it
 * is null. With --room-characters it flags the voices the room also uses
 * (consumers = {comic,room}). For every book it turns each staged clone
 * file with status "ready to clone" or "approved" into an archived
 * candidate row whose source clip is uploaded to comic-voice-clips.
 *
 * Dry run is the default and makes zero writes. --execute uploads each
 * candidate clip, checks the stored copy against the local md5, then writes
 * the rows. It never calls ElevenLabs, never writes castlist, and never
 * touches source_clip_path on existing rows.
 *
 * Inputs, read-only:
 *   VOICE_LAB_REPO  voice-lab repo (default $HOME/projects/voice-lab)
 *   VOICE_LAB       voice-lab workspace (default $HOME/Movies/library/voice-lab)
 *
 * Usage:
 *   pnpm voice-lab-import -- --book tmnt-x-mmpr [--room-characters <path>] [--execute]
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { supabase } from "./lib/supabase.js";

const BUCKET = "comic-voice-clips";
const CANDIDATE_STATUSES = new Set(["ready to clone", "approved"]);
const ROOM_TESTER_ID = "66KaORPuFP0qLgNZk7im";
// The bucket's allowed_mime_types.
const CONTENT_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
};

const BOOKS = {
  "tmnt-x-mmpr": {
    cast: "casting/tmnt-x-mmpr/cast.json",
    snapshot: "casting/tmnt-x-mmpr/elevenlabs-voices-snapshot.json",
  },
  "dc-x-sonic": {
    cast: "casting/dc-x-sonic/dc-x-sonic-cast.json",
    snapshot: null,
  },
} as const;
type Book = keyof typeof BOOKS;

interface Args {
  book: Book;
  roomCharacters: string | null;
  execute: boolean;
}

function usage(code: number): never {
  console.log(
    `Usage: pnpm voice-lab-import -- --book <${Object.keys(BOOKS).join("|")}> [--room-characters <path>] [--execute]`,
  );
  process.exit(code);
}

function parseArgs(): Args {
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  if (argv.includes("--help") || argv.includes("-h")) usage(0);
  const valueOf = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };
  const book = valueOf("--book");
  if (!book || !(book in BOOKS)) usage(1);
  const room = valueOf("--room-characters");
  return {
    book: book as Book,
    roomCharacters: room ? path.resolve(room) : null,
    execute: argv.includes("--execute"),
  };
}

interface SnapshotVoice {
  voice_id: string;
  category: string;
  description: string | null;
  labels: Record<string, string> | null;
}

interface VoiceRow {
  id: string;
  display_name: string;
  current_elevenlabs_id: string | null;
  design_prompt: string | null;
  source_clip_path: string | null;
  consumers?: string[] | null;
  character_id?: string | null;
}

interface Character {
  id: string;
  aliases: string[] | null;
}

interface StagedClip {
  character: string;
  file: string;
}

interface Candidate {
  character: string;
  localPath: string;
  objectPath: string;
  contentType: string;
  md5: string;
  bytes: number;
  characterId: string | null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const md5Of = (buf: Buffer | Uint8Array) =>
  createHash("md5").update(buf).digest("hex");

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

/** True when every column in `cols` exists on voices (42703 = no such column). */
async function hasColumns(cols: string): Promise<boolean> {
  const { error } = await supabase.from("voices").select(cols).limit(1);
  if (!error) return true;
  if (error.code === "42703") return false;
  throw new Error(`probe voices(${cols}): ${error.message}`);
}

/** Resolve a lab name like "Red Ranger (Jason)" via characters.id or aliases. */
function characterResolver(chars: Character[]) {
  const byKey = new Map<string, string>();
  for (const c of chars) {
    byKey.set(norm(c.id), c.id);
    for (const a of c.aliases ?? []) byKey.set(norm(a), c.id);
  }
  return (name: string): string | null => {
    const inner = /\(([^)]+)\)/.exec(name)?.[1];
    const tries = [name, name.replace(/\s*\([^)]*\)/g, ""), inner ?? ""];
    for (const t of tries) {
      const hit = t ? byKey.get(norm(t)) : undefined;
      if (hit) return hit;
    }
    return null;
  };
}

/** Staged clone files from the book's cast file; rejects go to `skip`. */
function stagedClips(
  book: Book,
  cast: unknown,
  skip: (what: string, reason: string) => void,
): StagedClip[] {
  const out: StagedClip[] = [];
  if (book === "dc-x-sonic") {
    // No per-row status: the file only lists reels the owner judged good.
    const chars = (
      cast as {
        characters: Record<string, { primary?: { cloneFile?: string } }>;
      }
    ).characters;
    for (const [character, c] of Object.entries(chars)) {
      if (c.primary?.cloneFile)
        out.push({ character, file: c.primary.cloneFile });
      else skip(character, "no primary cloneFile");
    }
    return out;
  }
  const rows = (
    cast as { cast: { character: string; file: string; status: string }[] }
  ).cast;
  for (const r of rows) {
    if (/\s(?:\*\*)?or(?:\*\*)?\s/i.test(r.file)) {
      skip(r.character, "two files (A or B), pending #114");
      continue;
    }
    if (!CANDIDATE_STATUSES.has(r.status)) {
      skip(r.character, `status "${r.status}"`);
      continue;
    }
    // Drop trailing notes like "(alternate)" or "(fallback)".
    out.push({
      character: r.character,
      file: r.file.replace(/\s*\([^)]*\)\s*$/, "").trim(),
    });
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const labRepo =
    process.env.VOICE_LAB_REPO ?? path.join(homedir(), "projects/voice-lab");
  const workspace =
    process.env.VOICE_LAB ?? path.join(homedir(), "Movies/library/voice-lab");
  const inputs = BOOKS[args.book];
  const cloneRoot = path.join(workspace, "clone-sources", args.book);

  const registryCols = await hasColumns(
    "consumers, description, labels, source_clip_md5",
  );
  const characterCol = await hasColumns("character_id");
  if (args.execute && !registryCols)
    throw new Error(
      "voices is missing the registry columns; apply the voices_registry_columns migration before --execute",
    );

  const select = [
    "id, display_name, current_elevenlabs_id, design_prompt, source_clip_path",
    registryCols ? "consumers" : null,
    characterCol ? "character_id" : null,
  ]
    .filter(Boolean)
    .join(", ");
  const [voicesRes, charsRes] = await Promise.all([
    supabase.from("voices").select(select),
    supabase.from("characters").select("id, aliases"),
  ]);
  if (voicesRes.error) throw new Error(voicesRes.error.message);
  if (charsRes.error) throw new Error(charsRes.error.message);
  const voices = (voicesRes.data ?? []) as unknown as VoiceRow[];
  const resolve = characterResolver((charsRes.data ?? []) as Character[]);
  const byElId = new Map(
    voices
      .filter((v) => v.current_elevenlabs_id)
      .map((v) => [v.current_elevenlabs_id!, v]),
  );
  const importedPaths = new Set(
    voices.map((v) => v.source_clip_path).filter(Boolean),
  );

  const skips: string[] = [];
  const skip = (what: string, reason: string) =>
    skips.push(`  - ${what}: ${reason}`);
  const updates = new Map<
    string,
    { row: VoiceRow; set: Record<string, unknown> }
  >();
  const setFor = (row: VoiceRow) => {
    const u = updates.get(row.id) ?? { row, set: {} };
    updates.set(row.id, u);
    return u.set;
  };
  const lines = { updates: [] as string[], room: [] as string[] };

  // 1. Existing rows: description, labels, design_prompt from the snapshot.
  if (inputs.snapshot) {
    const snap = await readJson<Record<string, SnapshotVoice>>(
      path.join(labRepo, inputs.snapshot),
    );
    for (const [elName, s] of Object.entries(snap)) {
      const row = byElId.get(s.voice_id);
      if (!row) {
        skip(
          `${elName} (${s.voice_id})`,
          s.voice_id === ROOM_TESTER_ID
            ? "room tester, gets no row (row 19 deletes it)"
            : "no voices row with this ElevenLabs id",
        );
        continue;
      }
      const set = setFor(row);
      const desc = s.description?.trim() || null;
      const fields: string[] = [];
      if (desc) {
        set.description = desc;
        fields.push("description");
      }
      set.labels = s.labels ?? {};
      fields.push("labels");
      if (s.category === "generated" && desc && row.design_prompt == null) {
        set.design_prompt = desc;
        fields.push("design_prompt");
      }
      const charId = resolve(row.display_name);
      if (charId && characterCol && row.character_id == null)
        set.character_id = charId;
      lines.updates.push(
        `  ~ ${row.display_name} (${s.voice_id}, ${s.category}): ${fields.join(", ")}${desc ? "" : " (snapshot has no description)"}; character ${charId ?? "unmatched"}`,
      );
    }
  }

  // 2. Voices the room also uses.
  if (args.roomCharacters) {
    const room = await readJson<Record<string, unknown>>(args.roomCharacters);
    for (const elId of Object.keys(room)) {
      const row = byElId.get(elId);
      if (!row) {
        skip(
          `room ${elId}`,
          elId === ROOM_TESTER_ID
            ? "room tester, gets no row (row 19 deletes it)"
            : "no voices row with this ElevenLabs id",
        );
        continue;
      }
      const consumers = [
        ...new Set([...(row.consumers ?? ["comic"]), "comic", "room"]),
      ];
      setFor(row).consumers = consumers;
      lines.room.push(
        `  ~ ${row.display_name} (${elId}): consumers -> {${consumers.join(",")}}`,
      );
    }
  }

  // 3. Candidates from staged clone files.
  const cast = await readJson<unknown>(path.join(labRepo, inputs.cast));
  const candidates: Candidate[] = [];
  for (const clip of stagedClips(args.book, cast, skip)) {
    const localPath = path.resolve(cloneRoot, clip.file);
    const rel = path.relative(cloneRoot, localPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      skip(clip.character, `file path leaves the clone root: ${clip.file}`);
      continue;
    }
    // Flat object name: voice-rotation.ts reads a "/" in source_clip_path
    // as a bucket prefix.
    const objectPath = `${args.book}__${rel.split(path.sep).join("__")}`;
    if (importedPaths.has(objectPath)) {
      skip(clip.character, `already imported as ${objectPath}`);
      continue;
    }
    const contentType = CONTENT_TYPES[path.extname(rel).toLowerCase()];
    if (!contentType) {
      skip(clip.character, `bucket takes mp3, m4a or wav only: ${rel}`);
      continue;
    }
    if (!existsSync(localPath)) {
      skip(clip.character, `file missing: ${rel}`);
      continue;
    }
    const buf = await readFile(localPath);
    candidates.push({
      character: clip.character,
      localPath,
      objectPath,
      contentType,
      md5: md5Of(buf),
      bytes: buf.length,
      characterId: resolve(clip.character),
    });
  }

  // Plan.
  const mode = args.execute ? "EXECUTE" : "dry run, no writes";
  console.log(`\nvoice-lab-import ${args.book} (${mode})`);
  console.log(
    `registry columns: ${registryCols ? "present" : "missing, migration not applied yet (plan only)"}`,
  );
  console.log(
    `voices.character_id: ${characterCol ? "present, filled where null" : "missing (#95), matches print only"}`,
  );
  console.log(`\nUpdates from the snapshot (${lines.updates.length}):`);
  lines.updates.forEach((l) => console.log(l));
  console.log(
    `\nRoom flags (${lines.room.length}):${args.roomCharacters ? "" : " none, no --room-characters"}`,
  );
  lines.room.forEach((l) => console.log(l));
  console.log(`\nCandidates (${candidates.length}), status archived:`);
  for (const c of candidates)
    console.log(
      `  + ${c.character}: character ${c.characterId ?? "unmatched (stays null)"}; upload ${path.relative(cloneRoot, c.localPath)} -> ${BUCKET}/${c.objectPath} (${(c.bytes / 1e6).toFixed(2)} MB, md5 ${c.md5})`,
    );
  console.log(`\nSkips (${skips.length}):`);
  skips.forEach((l) => console.log(l));
  console.log(
    `\nSummary: ${lines.updates.length} updates, ${lines.room.length} room flags, ${candidates.length} candidates, ${skips.length} skips`,
  );

  if (!args.execute) {
    console.log("Dry run: nothing written. Pass --execute to apply.\n");
    return;
  }

  // Execute.
  const failures: string[] = [];
  for (const { row, set } of updates.values()) {
    const { error } = await supabase
      .from("voices")
      .update(set)
      .eq("id", row.id);
    if (error) failures.push(`update ${row.display_name}: ${error.message}`);
  }

  for (const c of candidates) {
    const store = supabase.storage.from(BUCKET);
    const up = await store.upload(c.objectPath, await readFile(c.localPath), {
      contentType: c.contentType,
      upsert: false,
    });
    // An existing object is fine only if its bytes match; the md5 check decides.
    if (up.error && !/exist|duplicate/i.test(up.error.message)) {
      failures.push(`upload ${c.objectPath}: ${up.error.message}`);
      continue;
    }
    const down = await store.download(c.objectPath);
    if (down.error || !down.data) {
      failures.push(`verify ${c.objectPath}: ${down.error?.message}`);
      continue;
    }
    const stored = md5Of(Buffer.from(await down.data.arrayBuffer()));
    if (stored !== c.md5) {
      failures.push(
        `verify ${c.objectPath}: stored md5 ${stored} != local ${c.md5}; row not written`,
      );
      continue;
    }
    const { error } = await supabase.from("voices").insert({
      display_name: c.character,
      status: "archived",
      current_elevenlabs_id: null,
      source_clip_path: c.objectPath,
      source_clip_md5: c.md5,
      ...(characterCol && c.characterId ? { character_id: c.characterId } : {}),
    });
    if (error) failures.push(`insert ${c.character}: ${error.message}`);
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`);
    failures.forEach((f) => console.error(`  ! ${f}`));
    process.exit(1);
  }
  console.log(
    `\nDone: ${updates.size} rows updated, ${candidates.length} candidates uploaded and inserted.\n`,
  );
}

main().catch((err) => {
  console.error("voice-lab-import:", err);
  process.exit(1);
});

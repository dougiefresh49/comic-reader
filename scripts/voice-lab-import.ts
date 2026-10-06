#!/usr/bin/env node

/**
 * Import a voice-lab handoff, manifest version 2 (#467), into `voices`,
 * `works`, `appearances` and the `comic-voice-clips` bucket.
 *
 * The manifest is `casting/<folder>/voices.json` in the voice-lab checkout
 * (or the file --manifest names): `{ "version": 2, "voices": [...] }`, one
 * row per voice, naming its character and work by id. The field rules are
 * the "Voice-lab handoff" section of docs/casting-data-model.html. Any
 * other version is refused before the database is read.
 *
 * Two halves:
 *   plan   planVoiceLabImport (scripts/lib/voice-lab-plan.ts) turns the
 *          manifest and the current rows into typed writes, skips and
 *          notes. It is pure; a write already true of the rows is not
 *          planned, so a rerun plans nothing.
 *   apply  only with --execute: hashes each row's local clip against the
 *          manifest md5 and uploads it (no overwrite, same-bytes only),
 *          then writes works, appearances and voices in that order. A row
 *          whose clip fails writes nothing. No castlist or casting_tasks
 *          write and no ElevenLabs call; restore puts a voice in a slot.
 *
 * Without --execute it prints the plan, and for each row whether its file
 * is under clone-sources/<folder>/ and hashes to its md5, and writes nothing.
 * --check runs the plan on fixtures/voice-lab/ with no database or network.
 *
 * Inputs, read-only:
 *   VOICE_LAB_REPO  voice-lab repo (default $HOME/projects/voice-lab)
 *   VOICE_LAB       voice-lab workspace (default $HOME/Movies/library/voice-lab)
 *
 * Usage:
 *   pnpm voice-lab-import -- --folder <folder> [--manifest <path>] [--execute]
 *   pnpm exec tsx --env-file=.env scripts/voice-lab-import.ts --check
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { clipContentType, uploadClip } from "~/lib/voice-slots/bucket";
import { md5Hex } from "~/lib/voice-slots/elevenlabs";
import {
  insertCandidateVoice,
  updateVoiceFacts,
} from "~/lib/voice-slots/import";
import type { VoiceRow } from "~/lib/voice-slots/types";
import {
  insertAppearances,
  insertWorks,
  MEDIA,
  readAppearances,
  readWorks,
} from "./lib/appearances.js";
import {
  clipObject,
  MANIFEST_VERSION,
  planVoiceLabImport,
  rowLabel,
  type AppearanceRow,
  type Manifest,
  type Plan,
  type PlanInput,
  type WorkRow,
  type Write,
} from "./lib/voice-lab-plan.js";

/**
 * The owner's v2 voices (AGENTS.md, "Voice slots"): the active rows of these
 * characters take no import write, whichever route a manifest row takes.
 */
const PROTECTED_CHARACTER_IDS = new Set([
  "michelangelo",
  "donatello",
  "raphael",
  "master-splinter",
]);

const FIXTURES = path.resolve("fixtures/voice-lab");

interface Args {
  folder: string | null;
  manifest: string | null;
  execute: boolean;
  check: boolean;
}

function usage(code: number): never {
  console.log(
    "Usage: pnpm voice-lab-import -- --folder <folder> [--manifest <path>] [--execute]\n" +
      "       pnpm exec tsx --env-file=.env scripts/voice-lab-import.ts --check",
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
  const args = {
    folder: valueOf("--folder"),
    manifest: valueOf("--manifest"),
    execute: argv.includes("--execute"),
    check: argv.includes("--check"),
  };
  if (!args.check && !args.folder) usage(1);
  if (
    args.folder &&
    (!/^[\w.-]+$/.test(args.folder) || /^\.+$/.test(args.folder))
  ) {
    console.error(`--folder must be one folder name, got "${args.folder}"`);
    process.exit(1);
  }
  return args;
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

/** The manifest, or exit 1 naming the version found and the file. */
async function readManifest(file: string): Promise<Manifest> {
  const raw = await readJson<{ version?: unknown; voices?: unknown }>(file);
  if (raw?.version !== MANIFEST_VERSION) {
    console.error(
      `${file}: manifest version ${JSON.stringify(raw?.version ?? null)}; this import reads version ${MANIFEST_VERSION} only. Nothing was read or written.`,
    );
    process.exit(1);
  }
  if (!Array.isArray(raw.voices)) {
    console.error(`${file}: "voices" is not a list. Nothing was written.`);
    process.exit(1);
  }
  return raw as Manifest;
}

function describeWrite(w: Write): string {
  const rows = `[row ${w.rows.join(", ")}]`;
  switch (w.kind) {
    case "insert_work":
      return `  + work ${w.row.id}: "${w.row.title}" (${w.row.year}, ${w.row.medium}, franchise ${w.row.franchise_id ?? "none"}) ${rows}`;
    case "insert_appearance":
      return `  + appearance ${w.row.character_id} in ${w.row.work_id} (voice actor ${w.row.voice_actor ?? "unknown"}) ${rows}`;
    case "insert_voice":
      return `  + voice "${w.row.display_name}": ${w.row.character_id}, ${w.appearance ? `appearance in ${w.appearance.work_id}` : "designed, no appearance"}, archived, consumers {${w.row.consumers.join(",")}}, starting_pick ${w.row.starting_pick}; sample ${w.clip.object} (md5 ${w.clip.md5}) ${rows}`;
    case "update_voice": {
      const s = w.set;
      const fields = [
        s.description !== undefined && "description",
        s.labels !== undefined && "labels",
        s.design_prompt !== undefined && "design_prompt",
        s.starting_pick !== undefined && `starting_pick ${s.starting_pick}`,
        s.consumers && `consumers {${s.consumers.join(",")}}`,
        w.clip && `sample ${w.clip.object} (md5 ${w.clip.md5})`,
        s.status && `status ${s.status}`,
      ].filter(Boolean);
      return `  ~ voice "${w.display_name}" (${w.id}): ${fields.join(", ")} ${rows}`;
    }
  }
}

function printPlan(plan: Plan) {
  console.log(`\nWrites (${plan.writes.length}), in order:`);
  plan.writes.forEach((w) => console.log(describeWrite(w)));
  console.log(`\nSkips (${plan.skips.length}):`);
  plan.skips.forEach((s) => console.log(`  - ${s.label}: ${s.reason}`));
  console.log(`\nNotes (${plan.notes.length}):`);
  plan.notes.forEach((n) => console.log(`  * row ${n.row}: ${n.text}`));
}

/** The local copy of a manifest file, guarded to stay under the clone root. */
function localPath(cloneRoot: string, file: string): string | null {
  const p = path.resolve(cloneRoot, file);
  const rel = path.relative(cloneRoot, p);
  return rel.startsWith("..") || path.isAbsolute(rel) ? null : p;
}

// --- --check: the planning function on the committed fixtures -------------

interface FixtureRows {
  folder: string;
  protected_voice_ids: string[];
  characters: { id: string; display_name: string | null }[];
  franchises: string[];
  voices: VoiceRow[];
  works: WorkRow[];
  appearances: AppearanceRow[];
}

interface ExpectedCase {
  name: string;
  row: number;
  writes: Write[];
  skips: Plan["skips"];
  notes: Plan["notes"];
}

/** Stable JSON: object keys sorted, so key order never counts as a change. */
function canon(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : 1,
          ),
        )
      : x,
  );
}

function fixtureInput(manifest: Manifest, rows: FixtureRows): PlanInput {
  return {
    folder: rows.folder,
    manifest,
    voices: rows.voices,
    works: rows.works,
    appearances: rows.appearances,
    characters: new Map(rows.characters.map((c) => [c.id, c.display_name])),
    franchiseIds: new Set(rows.franchises),
    media: MEDIA,
    protectedVoiceIds: new Set(rows.protected_voice_ids),
  };
}

async function runCheck(): Promise<never> {
  globalThis.fetch = (() => {
    throw new Error("--check made a network call");
  }) as typeof fetch;
  const manifest = await readManifest(path.join(FIXTURES, "manifest.json"));
  const before = await readJson<FixtureRows>(
    path.join(FIXTURES, "rows-before.json"),
  );
  const after = await readJson<FixtureRows>(
    path.join(FIXTURES, "rows-after.json"),
  );
  const expected = await readJson<{ cases: ExpectedCase[] }>(
    path.join(FIXTURES, "expected-writes.json"),
  );
  const plan = planVoiceLabImport(fixtureInput(manifest, before));
  let failed = 0;
  const fail = (line: string, detail?: string) => {
    failed++;
    console.log(`FAIL ${line}`);
    if (detail) console.log(detail);
  };

  const covered = new Set<number>();
  for (const c of expected.cases) {
    covered.add(c.row);
    const actual = {
      writes: plan.writes.filter((w) => w.rows.includes(c.row)),
      skips: plan.skips.filter((s) => s.row === c.row),
      notes: plan.notes.filter((n) => n.row === c.row),
    };
    const want = { writes: c.writes, skips: c.skips, notes: c.notes };
    const summary = `${actual.writes.length} write(s), ${actual.skips.length} skip(s), ${actual.notes.length} note(s)`;
    if (canon(actual) === canon(want))
      console.log(`ok   row ${c.row} ${c.name}: ${summary}`);
    else
      fail(
        `row ${c.row} ${c.name}: ${summary}`,
        `  expected ${JSON.stringify(want, null, 2)}\n  actual   ${JSON.stringify(actual, null, 2)}`,
      );
  }
  const stray = [
    ...plan.writes.flatMap((w) => w.rows),
    ...plan.skips.map((s) => s.row),
    ...plan.notes.map((n) => n.row),
  ].filter((r) => !covered.has(r));
  if (stray.length > 0)
    fail(
      `every planned row is a named case: rows ${[...new Set(stray)].join(", ")} are not`,
    );
  else console.log("ok   every planned row is a named case");
  if (manifest.voices.length !== covered.size)
    fail(
      `every manifest row is a named case: ${covered.size} cases for ${manifest.voices.length} rows`,
    );
  const rank = {
    insert_work: 0,
    insert_appearance: 1,
    insert_voice: 2,
    update_voice: 2,
  };
  const ordered = plan.writes.every(
    (w, i, all) => i === 0 || rank[all[i - 1]!.kind] <= rank[w.kind],
  );
  if (ordered)
    console.log("ok   writes ordered work, then appearance, then voice");
  else fail("writes ordered work, then appearance, then voice");

  const again = planVoiceLabImport(fixtureInput(manifest, after));
  if (again.writes.length === 0)
    console.log(
      `ok   rows-after: the whole manifest against rows-after.json plans no write (${again.skips.length} skips and ${again.notes.length} notes repeat)`,
    );
  else
    fail(
      `rows-after: ${again.writes.length} write(s) planned`,
      again.writes.map(describeWrite).join("\n"),
    );

  console.log(
    failed === 0
      ? `\nvoice-lab-import --check: all ${expected.cases.length + 3} checks passed, no database or network call.`
      : `\nvoice-lab-import --check: ${failed} failed.`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

// --- dry run and --execute -------------------------------------------------

async function readCurrent(supabase: SupabaseClient) {
  const { readVoices } = await import("~/lib/voice-slots/registry");
  const [voices, works, appearances, characters, franchises] =
    await Promise.all([
      readVoices(supabase),
      readWorks(supabase),
      readAppearances(supabase),
      supabase.from("characters").select("id, display_name"),
      supabase.from("franchises").select("id"),
    ]);
  if (characters.error)
    throw new Error(`read characters: ${characters.error.message}`);
  if (franchises.error)
    throw new Error(`read franchises: ${franchises.error.message}`);
  return {
    voices,
    works,
    appearances,
    characters: new Map(
      (characters.data as { id: string; display_name: string | null }[]).map(
        (c) => [c.id, c.display_name],
      ),
    ),
    franchiseIds: new Set(
      (franchises.data as { id: string }[]).map((f) => f.id),
    ),
  };
}

/** Per row: is the file under the clone root, and does it hash to md5? */
async function fileReport(
  manifest: Manifest,
  folder: string,
  cloneRoot: string,
): Promise<string[]> {
  const lines: string[] = [];
  for (const [i, m] of manifest.voices.entries()) {
    const label = rowLabel(i + 1, m);
    const clip = clipObject(folder, m.file);
    if ("error" in clip) {
      lines.push(`  - ${label}: ${clip.error}`);
      continue;
    }
    const p = localPath(cloneRoot, clip.file);
    if (!p) lines.push(`  - ${label}: file path leaves the clone root`);
    else if (!existsSync(p)) lines.push(`  - ${label}: file missing`);
    else {
      const md5 = md5Hex(await readFile(p));
      lines.push(
        md5 === m.md5
          ? `  - ${label}: file present, md5 matches`
          : `  - ${label}: file present, md5 ${md5} differs from the manifest's ${m.md5 ?? "(none)"}`,
      );
    }
  }
  return lines;
}

async function apply(
  supabase: SupabaseClient,
  plan: Plan,
  cloneRoot: string,
): Promise<string[]> {
  const failures: string[] = [];
  const failedRows = new Set<number>();
  const failRow = (row: number, why: string) => {
    failedRows.add(row);
    failures.push(`row ${row}: ${why}`);
  };
  const live = (w: Write) => w.rows.some((r) => !failedRows.has(r));

  // 1. Each clip: the local file must hash to the manifest md5, then upload.
  for (const w of plan.writes) {
    if ((w.kind !== "insert_voice" && w.kind !== "update_voice") || !w.clip)
      continue;
    const row = w.rows[0]!;
    const p = localPath(cloneRoot, w.clip.file);
    if (!p || !existsSync(p)) {
      failRow(row, `file missing: ${w.clip.file}`);
      continue;
    }
    const bytes = new Uint8Array(await readFile(p));
    const md5 = md5Hex(bytes);
    if (md5 !== w.clip.md5) {
      failRow(
        row,
        `${w.clip.file} hashes to ${md5}, the manifest says ${w.clip.md5}; nothing written for this row`,
      );
      continue;
    }
    try {
      await uploadClip(
        supabase,
        w.clip.object,
        bytes,
        clipContentType(w.clip.file),
      );
    } catch (err) {
      failRow(row, err instanceof Error ? err.message : String(err));
    }
  }

  // 2. Works, then appearances, then voices.
  const pick = <K extends Write["kind"]>(kind: K) =>
    plan.writes.filter(
      (w): w is Extract<Write, { kind: K }> => w.kind === kind && live(w),
    );
  try {
    await insertWorks(
      supabase,
      pick("insert_work").map((w) => w.row),
    );
    await insertAppearances(
      supabase,
      pick("insert_appearance").map((w) => w.row),
    );
  } catch (err) {
    failures.push(err instanceof Error ? err.message : String(err));
    return failures;
  }
  const appearanceId = new Map(
    (await readAppearances(supabase)).map((a) => [
      `${a.character_id}\u0000${a.work_id}`,
      a.id,
    ]),
  );
  for (const w of plan.writes) {
    if (!live(w)) continue;
    const row = w.rows[0]!;
    try {
      if (w.kind === "insert_voice") {
        const id = w.appearance
          ? appearanceId.get(
              `${w.appearance.character_id}\u0000${w.appearance.work_id}`,
            )
          : null;
        if (w.appearance && !id) {
          failRow(
            row,
            `no appearance ${w.appearance.character_id} in ${w.appearance.work_id} after the insert`,
          );
          continue;
        }
        // The row's status is archived; insertCandidateVoice sets it again.
        await insertCandidateVoice(supabase, {
          ...w.row,
          appearance_id: id ?? null,
        });
      } else if (w.kind === "update_voice")
        await updateVoiceFacts(supabase, w.id, w.set);
    } catch (err) {
      failRow(row, err instanceof Error ? err.message : String(err));
    }
  }
  return failures;
}

async function main() {
  const args = parseArgs();
  if (args.check) await runCheck();
  const folder = args.folder!;
  const labRepo =
    process.env.VOICE_LAB_REPO ?? path.join(homedir(), "projects/voice-lab");
  const workspace =
    process.env.VOICE_LAB ?? path.join(homedir(), "Movies/library/voice-lab");
  const cloneRoot = path.join(workspace, "clone-sources", folder);
  const manifestFile = args.manifest
    ? path.resolve(args.manifest)
    : path.join(labRepo, "casting", folder, "voices.json");

  const manifest = await readManifest(manifestFile);
  // The client is built only past the version check and never on --check.
  const { supabase } = await import("./lib/supabase.js");
  const current = await readCurrent(supabase);
  // A typo here would protect nothing, so a missing character id stops the run.
  const unknownProtected = [...PROTECTED_CHARACTER_IDS].filter(
    (id) => !current.characters.has(id),
  );
  if (unknownProtected.length > 0) {
    console.error(
      `PROTECTED_CHARACTER_IDS names ${unknownProtected.join(", ")}, not in characters. Nothing was written.`,
    );
    process.exit(1);
  }
  const protectedVoiceIds = new Set(
    current.voices
      .filter(
        (v) =>
          v.status === "active" &&
          v.character_id !== null &&
          PROTECTED_CHARACTER_IDS.has(v.character_id),
      )
      .map((v) => v.id),
  );
  const unprotected = [...PROTECTED_CHARACTER_IDS].filter(
    (id) =>
      !current.voices.some(
        (v) => v.status === "active" && v.character_id === id,
      ),
  );
  const plan = planVoiceLabImport({
    folder,
    manifest,
    ...current,
    media: MEDIA,
    protectedVoiceIds,
  });

  const mode = args.execute ? "EXECUTE" : "dry run, no writes";
  console.log(`\nvoice-lab-import ${folder} (${mode})`);
  console.log(`Manifest: ${manifestFile}, ${manifest.voices.length} row(s)`);
  console.log(
    `Read: ${current.voices.length} voices, ${current.works.length} works, ${current.appearances.length} appearances, ${current.characters.size} characters, ${current.franchiseIds.size} franchises; ${protectedVoiceIds.size} protected voices${unprotected.length > 0 ? ` (no active voice to protect for ${unprotected.join(", ")})` : ""}`,
  );
  printPlan(plan);
  console.log(`\nLocal files under clone-sources/${folder}/:`);
  (await fileReport(manifest, folder, cloneRoot)).forEach((l) =>
    console.log(l),
  );
  console.log(
    `\nSummary: ${plan.writes.length} writes, ${plan.skips.length} skips, ${plan.notes.length} notes`,
  );

  if (!args.execute) {
    console.log("Dry run: nothing written.");
    return;
  }

  const failures = await apply(supabase, plan, cloneRoot);
  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`);
    failures.forEach((f) => console.error(`  ! ${f}`));
    process.exit(1);
  }
  console.log(`\nDone: ${plan.writes.length} writes applied.\n`);
}

main().catch((err) => {
  console.error("voice-lab-import:", err);
  process.exit(1);
});

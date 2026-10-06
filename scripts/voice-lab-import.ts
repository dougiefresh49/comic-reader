#!/usr/bin/env node

/**
 * Import voice-lab's clip library (#474) into `voices`, `appearances`,
 * `voice_lookups` and the `comic-voice-clips` bucket.
 *
 * The library is voice-lab's clone sources, organized by the work each clip
 * came from, with one index: `<library>/index.json`, `{ "version": 1,
 * "clips": [...] }`. A clip row carries `file` (relative to the library),
 * `md5`, `character` (voice-lab's display name), `work { slug, title, year,
 * kind }` and `status`; any other field is ignored. Any other version is
 * refused before the database is read. The index names no comic-reader id,
 * description or label: a clip already stored matches its voice by md5, a
 * new one resolves its character through the name rule and its work as
 * `slugify(title)-year`, and each voice's description and labels come from a
 * lookup made here (scripts/lib/voice-lookups.ts).
 *
 * Two halves:
 *   plan   planVoiceLabImport (scripts/lib/voice-lab-plan.ts) turns the
 *          index, the current rows and the stored lookups into typed writes,
 *          skips, notes and the voices to describe. It is pure; a write
 *          already true of the rows is not planned, so a rerun plans nothing.
 *   apply  only with --execute: hashes each new clip against the index md5
 *          and uploads it (no overwrite, same bytes only), then writes
 *          appearances and voices in that order. A clip whose upload fails
 *          writes nothing.
 *
 * The three runs:
 *   (no flag)   no Gemini call and no write. Prints the plan, each voice to
 *               describe with its stored description and labels or "lookup
 *               needed", and the count of lookups needed.
 *   --describe  one GEMINI_FAST call per lookup needed, each stored in
 *               voice_lookups and printed. Writes that table and nothing else.
 *   --execute   no Gemini call. Writes the plan: each voice's missing
 *               description and labels from voice_lookups (never over a value
 *               it holds) and the new clips. A voice whose lookup is not
 *               stored takes no write, and a new voice in that state is not
 *               inserted.
 * --describe with --execute is refused. No castlist, casting_tasks, works or
 * characters write, and no ElevenLabs call; restore puts a voice in a slot.
 * --check runs the plan on fixtures/voice-lab/ with no database or network.
 *
 * Input, read-only: --library <dir>, default $VOICE_LAB/clone-sources
 * (VOICE_LAB defaults to $HOME/Movies/library/voice-lab).
 *
 * Usage:
 *   pnpm voice-lab-import -- [--library <dir>] [--describe] [--execute]
 *   pnpm exec tsx --env-file=.env scripts/voice-lab-import.ts --check
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  readNamedCharacters,
  type NamedCharacter,
} from "~/lib/character-aliases";
import { clipContentType, uploadClip } from "~/lib/voice-slots/bucket";
import { md5Hex } from "~/lib/voice-slots/elevenlabs";
import {
  insertCandidateVoice,
  updateVoiceFacts,
} from "~/lib/voice-slots/import";
import type { VoiceRow } from "~/lib/voice-slots/types";
import {
  insertAppearances,
  readAppearances,
  readWorks,
} from "./lib/appearances.js";
import {
  clipFile,
  clipLabel,
  INDEX_VERSION,
  lookupsNeeded,
  planVoiceLabImport,
  type AppearanceRow,
  type Describe,
  type LibraryIndex,
  type Plan,
  type PlanInput,
  type WorkRow,
  type Write,
} from "./lib/voice-lab-plan.js";
import {
  insertVoiceLookup,
  lookUpVoice,
  readVoiceLookups,
  type VoiceLookupRow,
} from "./lib/voice-lookups.js";

/**
 * The owner's v2 voices (AGENTS.md, "Voice slots"): the active rows of these
 * characters take no import write.
 */
const PROTECTED_CHARACTER_IDS = new Set([
  "michelangelo",
  "donatello",
  "raphael",
  "master-splinter",
]);

const FIXTURES = path.resolve("fixtures/voice-lab");

interface Args {
  library: string;
  describe: boolean;
  execute: boolean;
  check: boolean;
}

function usage(code: number): never {
  console.log(
    "Usage: pnpm voice-lab-import -- [--library <dir>] [--describe] [--execute]\n" +
      "       pnpm exec tsx --env-file=.env scripts/voice-lab-import.ts --check",
  );
  process.exit(code);
}

function parseArgs(): Args {
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  if (argv.includes("--help") || argv.includes("-h")) usage(0);
  const i = argv.indexOf("--library");
  const workspace =
    process.env.VOICE_LAB ?? path.join(homedir(), "Movies/library/voice-lab");
  const args = {
    library: path.resolve(
      i >= 0 ? (argv[i + 1] ?? "") : path.join(workspace, "clone-sources"),
    ),
    describe: argv.includes("--describe"),
    execute: argv.includes("--execute"),
    check: argv.includes("--check"),
  };
  if (i >= 0 && !argv[i + 1]) usage(1);
  if (args.describe && args.execute) {
    console.error(
      "--describe and --execute are separate runs: describe first, read the output, then execute. Nothing was read or written.",
    );
    process.exit(1);
  }
  return args;
}

/** A path as printed: the home directory as ~, so pasted output names no user. */
const shown = (p: string) =>
  p.startsWith(homedir() + path.sep) ? `~${p.slice(homedir().length)}` : p;

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

/** The index, or exit 1 naming the version found and the file. */
async function readIndex(file: string): Promise<LibraryIndex> {
  const raw = await readJson<{ version?: unknown; clips?: unknown }>(file);
  if (raw?.version !== INDEX_VERSION) {
    console.error(
      `${shown(file)}: index version ${JSON.stringify(raw?.version ?? null)}; this import reads version ${INDEX_VERSION} only. Nothing was read or written.`,
    );
    process.exit(1);
  }
  if (!Array.isArray(raw.clips)) {
    console.error(
      `${shown(file)}: "clips" is not a list. Nothing was written.`,
    );
    process.exit(1);
  }
  return raw as LibraryIndex;
}

function describeWrite(w: Write): string {
  const rows = `[clip ${w.rows.join(", ")}]`;
  switch (w.kind) {
    case "insert_appearance":
      return `  + appearance ${w.row.character_id} in ${w.row.work_id} ${rows}`;
    case "insert_voice":
      return `  + voice "${w.row.display_name}": ${w.row.character_id}, ${w.appearance ? `appearance in ${w.appearance.work_id}` : "no appearance"}, archived, description and labels from voice_lookups; sample ${w.clip.object} (md5 ${w.clip.md5}) ${rows}`;
    case "update_voice": {
      const s = w.set;
      const fields = [
        s.description !== undefined && "description",
        s.labels !== undefined && "labels",
        w.clip && `sample ${w.clip.object} (md5 ${w.clip.md5})`,
        s.status && `status ${s.status}`,
      ].filter(Boolean);
      return `  ~ voice "${w.display_name}" (${w.id}): ${fields.join(", ")} ${rows}`;
    }
  }
}

const labelText = (l: Record<string, string>) =>
  Object.entries(l)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");

function describeLine(d: Describe): string {
  const head = `  ${d.voice}: ${d.key.character_id} in ${d.key.work_id} [clip ${d.row}]`;
  return d.stored
    ? `${head}\n      ${d.stored.description}\n      labels: ${labelText(d.stored.labels)}`
    : `${head}\n      lookup needed`;
}

function printPlan(plan: Plan) {
  console.log(`\nWrites (${plan.writes.length}), in order:`);
  plan.writes.forEach((w) => console.log(describeWrite(w)));
  console.log(`\nSkips (${plan.skips.length}):`);
  plan.skips.forEach((s) => console.log(`  - ${s.label}: ${s.reason}`));
  console.log(`\nNotes (${plan.notes.length}):`);
  plan.notes.forEach((n) => console.log(`  * clip ${n.row}: ${n.text}`));
  console.log(`\nVoices to describe (${plan.describe.length}):`);
  plan.describe.forEach((d) => console.log(describeLine(d)));
  console.log(`\nLookups needed: ${lookupsNeeded(plan).length}`);
}

/** The local copy of an index file, guarded to stay under the library. */
function localPath(library: string, file: string): string | null {
  const p = path.resolve(library, file);
  const rel = path.relative(library, p);
  return rel.startsWith("..") || path.isAbsolute(rel) ? null : p;
}

// --- --check: the planning function on the committed fixtures -------------

interface FixtureRows {
  protected_voice_ids: string[];
  characters: NamedCharacter[];
  voices: VoiceRow[];
  works: WorkRow[];
  appearances: AppearanceRow[];
}

interface ExpectedCase {
  name: string;
  clip: number;
  writes: Write[];
  skips: Plan["skips"];
  notes: Plan["notes"];
  describe: Describe[];
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

function fixtureInput(
  index: LibraryIndex,
  rows: FixtureRows,
  lookups: VoiceLookupRow[],
): PlanInput {
  return {
    clips: index.clips,
    voices: rows.voices,
    works: rows.works,
    appearances: rows.appearances,
    characters: rows.characters,
    lookups,
    protectedVoiceIds: new Set(rows.protected_voice_ids),
  };
}

/**
 * #469 item 2 on a fake client: a write that moves status filters on
 * `needs_clip`, and zero updated rows fail it.
 */
async function checkStatusGuard(): Promise<string | null> {
  const filters: string[] = [];
  const builder = {
    update: () => builder,
    eq: (col: string, val: string) => {
      filters.push(`${col}=${val}`);
      return builder;
    },
    select: () => Promise.resolve({ data: [], error: null }),
  };
  const fake = { from: () => builder } as unknown as SupabaseClient;
  try {
    await updateVoiceFacts(fake, "v-1", {
      source_clip_path: "x__y.mp3",
      source_clip_md5: "0".repeat(32),
      status: "archived",
    });
    return "a status move that updated no row did not fail";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!filters.includes("status=needs_clip"))
      return `no status=needs_clip filter (filters: ${filters.join(", ")})`;
    if (!/no longer needs_clip/.test(msg)) return `unexpected error: ${msg}`;
    return null;
  }
}

async function runCheck(): Promise<never> {
  globalThis.fetch = (() => {
    throw new Error("--check made a network call");
  }) as typeof fetch;
  const index = await readIndex(path.join(FIXTURES, "index.json"));
  const before = await readJson<FixtureRows>(
    path.join(FIXTURES, "rows-before.json"),
  );
  const after = await readJson<FixtureRows>(
    path.join(FIXTURES, "rows-after.json"),
  );
  const lookups = await readJson<VoiceLookupRow[]>(
    path.join(FIXTURES, "lookups.json"),
  );
  const expected = await readJson<{ cases: ExpectedCase[] }>(
    path.join(FIXTURES, "expected-writes.json"),
  );
  const plan = planVoiceLabImport(fixtureInput(index, before, lookups));
  let failed = 0;
  let passed = 0;
  const ok = (line: string) => {
    passed++;
    console.log(`ok   ${line}`);
  };
  const fail = (line: string, detail?: string) => {
    failed++;
    console.log(`FAIL ${line}`);
    if (detail) console.log(detail);
  };

  const covered = new Set<number>();
  for (const c of expected.cases) {
    covered.add(c.clip);
    const actual = {
      writes: plan.writes.filter((w) => w.rows.includes(c.clip)),
      skips: plan.skips.filter((s) => s.row === c.clip),
      notes: plan.notes.filter((n) => n.row === c.clip),
      describe: plan.describe.filter((d) => d.row === c.clip),
    };
    const want = {
      writes: c.writes,
      skips: c.skips,
      notes: c.notes,
      describe: c.describe,
    };
    const summary = `${actual.writes.length} write(s), ${actual.skips.length} skip(s), ${actual.notes.length} note(s), ${actual.describe.length} to describe`;
    if (canon(actual) === canon(want))
      ok(`clip ${c.clip} ${c.name}: ${summary}`);
    else
      fail(
        `clip ${c.clip} ${c.name}: ${summary}`,
        `  expected ${JSON.stringify(want, null, 2)}\n  actual   ${JSON.stringify(actual, null, 2)}`,
      );
  }
  const stray = [
    ...plan.writes.flatMap((w) => w.rows),
    ...plan.skips.map((s) => s.row),
    ...plan.notes.map((n) => n.row),
    ...plan.describe.map((d) => d.row),
  ].filter((r) => !covered.has(r));
  if (stray.length > 0)
    fail(
      `every planned clip is a named case: clips ${[...new Set(stray)].join(", ")} are not`,
    );
  else ok("every planned clip is a named case");
  if (index.clips.length !== covered.size)
    fail(
      `every index clip is a named case: ${covered.size} cases for ${index.clips.length} clips`,
    );
  const ordered = plan.writes.every(
    (w, i, all) =>
      i === 0 ||
      w.kind !== "insert_appearance" ||
      all[i - 1]!.kind === "insert_appearance",
  );
  if (ordered) ok("writes ordered appearance, then voice");
  else fail("writes ordered appearance, then voice");

  const guard = await checkStatusGuard();
  if (guard === null)
    ok(
      "status guard (#469 item 2): updateVoiceFacts moving status filters on needs_clip and fails when no row updates",
    );
  else fail(`status guard (#469 item 2): ${guard}`);

  const again = planVoiceLabImport(fixtureInput(index, after, lookups));
  if (again.writes.length === 0)
    ok(
      `rows-after: the whole index against rows-after.json plans no write (${again.skips.length} skips and ${again.notes.length} notes repeat)`,
    );
  else
    fail(
      `rows-after: ${again.writes.length} write(s) planned`,
      again.writes.map(describeWrite).join("\n"),
    );

  console.log(
    failed === 0
      ? `\nvoice-lab-import --check: all ${passed} checks passed, no database or network call.`
      : `\nvoice-lab-import --check: ${failed} failed, ${passed} passed.`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

// --- dry run, --describe and --execute -------------------------------------

async function readCurrent(supabase: SupabaseClient) {
  const { readVoices } = await import("~/lib/voice-slots/registry");
  const [voices, works, appearances, characters, lookups] = await Promise.all([
    readVoices(supabase),
    readWorks(supabase),
    readAppearances(supabase),
    readNamedCharacters(supabase),
    readVoiceLookups(supabase),
  ]);
  return { voices, works, appearances, characters, lookups };
}

/** Each index file: present under the library, and hashing to its md5? */
async function fileReport(
  index: LibraryIndex,
  library: string,
): Promise<string[]> {
  const lines: string[] = [];
  let good = 0;
  for (const [i, c] of index.clips.entries()) {
    const label = clipLabel(i + 1, c);
    const file = clipFile(c.file);
    if ("error" in file) {
      lines.push(`  - ${label}: ${file.error}`);
      continue;
    }
    const p = localPath(library, file.file);
    if (!p) lines.push(`  - ${label}: file path leaves the library`);
    else if (!existsSync(p)) lines.push(`  - ${label}: file missing`);
    else {
      const md5 = md5Hex(await readFile(p));
      if (md5 === c.md5) good++;
      else
        lines.push(
          `  - ${label}: md5 ${md5} differs from the index's ${typeof c.md5 === "string" ? c.md5 : "(none)"}`,
        );
    }
  }
  return [
    `  ${good} of ${index.clips.length} present with a matching md5`,
    ...lines,
  ];
}

async function apply(
  supabase: SupabaseClient,
  plan: Plan,
  library: string,
): Promise<string[]> {
  const failures: string[] = [];
  const failedRows = new Set<number>();
  const failRow = (row: number, why: string) => {
    failedRows.add(row);
    failures.push(`clip ${row}: ${why}`);
  };
  const live = (w: Write) => w.rows.some((r) => !failedRows.has(r));

  // 1. Each new clip: the local file must hash to the index md5, then upload.
  for (const w of plan.writes) {
    if ((w.kind !== "insert_voice" && w.kind !== "update_voice") || !w.clip)
      continue;
    const row = w.rows[0]!;
    const p = localPath(library, w.clip.file);
    if (!p || !existsSync(p)) {
      failRow(row, `file missing: ${w.clip.file}`);
      continue;
    }
    const bytes = new Uint8Array(await readFile(p));
    const md5 = md5Hex(bytes);
    if (md5 !== w.clip.md5) {
      failRow(
        row,
        `${w.clip.file} hashes to ${md5}, the index says ${w.clip.md5}; nothing written for this clip`,
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

  // 2. Appearances, then voices.
  try {
    await insertAppearances(
      supabase,
      plan.writes
        .filter(
          (w): w is Extract<Write, { kind: "insert_appearance" }> =>
            w.kind === "insert_appearance" && live(w),
        )
        .map((w) => w.row),
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

/** --describe: one lookup per key with nothing stored, each stored. */
async function describeAll(
  supabase: SupabaseClient,
  plan: Plan,
): Promise<string[]> {
  const { getGeminiClient } = await import("~/lib/gemini-client");
  const gemini = getGeminiClient();
  const failures: string[] = [];
  const needed = lookupsNeeded(plan);
  console.log(`\nDescribing ${needed.length} voice(s):`);
  for (const d of needed) {
    const key = `${d.key.character_id} in ${d.key.work_id}`;
    const result = await lookUpVoice(gemini, d);
    if (!result.ok) {
      failures.push(`${key}: ${result.reasons.join("; then ")}`);
      console.log(`  ! ${key}: not stored (${result.reasons.join("; then ")})`);
      continue;
    }
    await insertVoiceLookup(supabase, d.key, result.answer, result.model);
    console.log(
      `  ${key} (${d.character}, ${d.work.title} ${d.work.year}${d.voice_actor ? `, ${d.voice_actor}` : ""})\n      model names the actor: ${result.answer.actor}\n      ${result.answer.description}\n      labels: ${labelText(result.answer.labels)}`,
    );
  }
  return failures;
}

async function main() {
  const args = parseArgs();
  if (args.check) await runCheck();
  const indexFile = path.join(args.library, "index.json");
  const index = await readIndex(indexFile);
  // The client is built only past the version check and never on --check.
  const { supabase } = await import("./lib/supabase.js");
  const current = await readCurrent(supabase);
  // A typo here would protect nothing, so a missing character id stops the run.
  const unknownProtected = [...PROTECTED_CHARACTER_IDS].filter(
    (id) => !current.characters.some((c) => c.id === id),
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
    clips: index.clips,
    voices: current.voices,
    works: current.works,
    appearances: current.appearances,
    characters: current.characters,
    lookups: current.lookups.rows,
    protectedVoiceIds,
  });

  const mode = args.execute
    ? "EXECUTE"
    : args.describe
      ? "describe, writes voice_lookups only"
      : "dry run, no writes";
  console.log(`\nvoice-lab-import (${mode})`);
  console.log(`Index: ${shown(indexFile)}, ${index.clips.length} clip(s)`);
  console.log(
    `Read: ${current.voices.length} voices, ${current.works.length} works, ${current.appearances.length} appearances, ${current.characters.length} characters, ${current.lookups.missing ? "no voice_lookups table (the migration is not applied; every lookup reads as not stored)" : `${current.lookups.rows.length} stored lookups`}; ${protectedVoiceIds.size} protected voices${unprotected.length > 0 ? ` (no active voice to protect for ${unprotected.join(", ")})` : ""}`,
  );
  printPlan(plan);
  console.log(`\nLocal files under ${shown(args.library)}:`);
  (await fileReport(index, args.library)).forEach((l) => console.log(l));
  console.log(
    `\nSummary: ${plan.writes.length} writes, ${plan.skips.length} skips, ${plan.notes.length} notes, ${plan.describe.length} voices to describe, ${lookupsNeeded(plan).length} lookups needed`,
  );

  if (!args.execute && !args.describe) {
    console.log("Dry run: nothing written.");
    return;
  }
  if (current.lookups.missing) {
    console.error(
      `\n--${args.execute ? "execute" : "describe"} needs the voice_lookups table; apply its migration first. Nothing was written.`,
    );
    process.exit(1);
  }

  const failures = args.describe
    ? await describeAll(supabase, plan)
    : await apply(supabase, plan, args.library);
  if (failures.length > 0) {
    console.error(
      `\n${failures.length} ${args.describe ? "failed lookup(s)" : "failure(s)"}:`,
    );
    failures.forEach((f) => console.error(`  ! ${f}`));
    process.exit(1);
  }
  console.log(
    args.describe
      ? `\nDone: ${lookupsNeeded(plan).length} lookups stored.\n`
      : `\nDone: ${plan.writes.length} writes applied.\n`,
  );
}

main().catch((err) => {
  console.error("voice-lab-import:", err);
  process.exit(1);
});

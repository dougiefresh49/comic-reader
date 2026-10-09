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
 *   --describe  one lookup per lookup needed (GEMINI_FAST, then the voice's
 *               clip to GEMINI_MEDIUM when the model knows no voice to
 *               describe), each stored in voice_lookups and printed. Writes
 *               that table and nothing else; reads the clip from the library
 *               or the bucket.
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
import {
  clipContentType,
  clipObjectPath,
  downloadClip,
  uploadClip,
} from "~/lib/voice-slots/bucket";
import { md5Hex } from "~/lib/voice-slots/elevenlabs";
import {
  insertCandidateVoice,
  updateVoiceFacts,
} from "~/lib/voice-slots/import";
// The owner's v2 voices: the active rows of these characters take no import write.
import {
  PROTECTED_CHARACTER_IDS,
  type VoiceRow,
} from "~/lib/voice-slots/types";
import {
  insertAppearances,
  readAppearances,
  readWorks,
} from "./lib/appearances.js";
import {
  clipFile,
  clipLabel,
  failedDependency,
  INDEX_VERSION,
  liveWrite,
  lookupsNeeded,
  planVoiceLabImport,
  type AppearanceRow,
  type Describe,
  type LibraryIndex,
  type Plan,
  type PlanInput,
  type VoiceLookupRow,
  type WorkRow,
  type Write,
} from "./lib/voice-lab-plan.js";
import {
  checkAnswer,
  checkClipAnswer,
  CLIP_MARK,
  insertVoiceLookup,
  lookupPrompt,
  lookUpVoice,
  readVoiceLookups,
  type ClipAudio,
} from "./lib/voice-lookups.js";

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
  let raw: { version?: unknown; clips?: unknown };
  try {
    raw = await readJson<typeof raw>(file);
  } catch (err) {
    // fs errors carry the absolute path; print the code, and the path as shown().
    const why =
      (err as { code?: string }).code ??
      (err instanceof Error ? err.message : String(err));
    console.error(
      `${shown(file)}: cannot read the index (${why}). Nothing was read or written.`,
    );
    process.exit(1);
  }
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
  if (d.refused)
    return `${head}\n      stored lookup refused: ${d.refused.join(", ")}`;
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

  // The actor rule on canned answers: no Gemini call.
  const answer = (actor: string) =>
    JSON.stringify({
      actor,
      known: true,
      description: "A low, steady voice.",
      labels: {
        gender: "male",
        age: "old",
        accent: "en-american",
        language: "en",
      },
    });
  const actorCases: [string, string | null, boolean][] = [
    ["Invented Actor One", "invented actor one", true],
    ["Actor One", "Invented Actor One", true],
    ["Someone Else", "Invented Actor One", false],
    ["Someone Else", null, true],
  ];
  const actorWrong = actorCases.filter(
    ([named, expected, pass]) =>
      !("refused" in checkAnswer(answer(named), expected)) !== pass,
  );
  if (actorWrong.length === 0)
    ok(
      "actor check: the same person passes (case, spacing, a shorter name), another person is refused, no appearance actor checks nothing",
    );
  else fail(`actor check: wrong on ${JSON.stringify(actorWrong)}`);

  // The fallback's mark on canned answers: it must name other works. A
  // phrase naming this title under another year is another work.
  const work = { title: "Invented Work", year: 2026 };
  const inferredAnswer = (inferred_from: string) =>
    JSON.stringify({ ...JSON.parse(answer("Actor One")), inferred_from });
  const inferredCases: [string, string | null][] = [
    ["", null],
    ["Actor One as Hero in invented work (2026 podcast)", null],
    [
      "Actor One as Hero in Invented Work (1990 film)",
      "Actor One as Hero in Invented Work (1990 film)",
    ],
    [
      "Actor One as Hero in Other Work (2019 video game)",
      "Actor One as Hero in Other Work (2019 video game)",
    ],
  ];
  const inferredWrong = inferredCases.filter(([named, kept]) => {
    const result = checkAnswer(inferredAnswer(named), null, true, work);
    return "refused" in result ? kept !== null : result.inferred_from !== kept;
  });
  if (inferredWrong.length === 0)
    ok(
      "inferred check: an empty inferred_from is refused, one naming the work under lookup is refused, one naming its title under another year or other works is kept on the answer",
    );
  else fail(`inferred check: wrong on ${JSON.stringify(inferredWrong)}`);
  const direct = checkAnswer(
    inferredAnswer("Invented Work (2026)"),
    null,
    false,
    work,
  );
  const notJson = checkAnswer("not json");
  if (
    !("refused" in direct) &&
    direct.inferred_from === null &&
    "refused" in notJson &&
    notJson.unknown === true
  )
    ok(
      "stage check: the direct stage stores no inferred_from and ignores the title, and a non-JSON answer counts as unknown so the fallback runs",
    );
  else fail("stage check: direct answer or non-JSON refusal is wrong");

  // The clip stage's check on canned answers: no actor asked or stored.
  const heard = checkClipAnswer(
    JSON.stringify({
      description: "A bright, quick voice.",
      labels: {
        gender: "female",
        age: "young",
        accent: "en-american",
        language: "en",
      },
    }),
  );
  const offVocabulary = checkClipAnswer(
    JSON.stringify({ ...JSON.parse(answer("")), labels: { gender: "girl" } }),
  );
  if (
    !("refused" in heard) &&
    heard.actor === "" &&
    heard.inferred_from === CLIP_MARK &&
    "refused" in offVocabulary &&
    "refused" in checkClipAnswer("not json")
  )
    ok(
      `clip check: an answer with no actor is kept, marked "${CLIP_MARK}"; labels outside the vocabulary and non-JSON are refused`,
    );
  else fail("clip check: wrong on a canned clip answer");

  // The full name in the prompt: beside the display name when it says more,
  // and the prompt unchanged when it does not.
  const subject = plan.describe[0]!;
  const prompt = (full_name: string | null) =>
    lookupPrompt({ ...subject, full_name });
  const plain = prompt(null);
  if (
    prompt(subject.character.toUpperCase()) === plain &&
    prompt("  ") === plain &&
    prompt("Invented Full Name").includes(
      `\nCharacter: ${subject.character} (Invented Full Name)\n`,
    ) &&
    plain.includes(`\nCharacter: ${subject.character}\n`)
  )
    ok(
      "full name: printed beside the display name when it differs, the prompt unchanged when it is missing, blank or the display name",
    );
  else fail("full name: wrong in the lookup prompt");

  // Apply's "is this write live" decision for a voice planned beside another
  // clip's: dropped when that clip failed, kept otherwise. No database call.
  const dependent = plan.writes.find(
    (w) => w.kind === "insert_voice" && w.depends_on !== undefined,
  );
  const first = dependent
    ? plan.writes.find(
        (w) =>
          w.kind === "insert_voice" &&
          dependent.kind === "insert_voice" &&
          w.rows.includes(dependent.depends_on!),
      )
    : undefined;
  const dep = dependent?.kind === "insert_voice" ? dependent.depends_on! : 0;
  const liveWrong = !dependent
    ? "no planned write carries depends_on"
    : !first
      ? `no planned voice write for clip ${dep}`
      : !liveWrite(dependent, new Set())
        ? "dropped with no clip failed"
        : liveWrite(dependent, new Set([dep]))
          ? `kept after clip ${dep} failed`
          : failedDependency(dependent, new Set([dep])) !== dep
            ? "the failure does not name the clip it depends on"
            : !liveWrite(first, new Set(dependent.rows))
              ? `clip ${dep} dropped when the dependent clip failed`
              : null;
  if (liveWrong === null)
    ok(
      `apply's live check: clip ${dependent!.rows[0]}'s voice (planned beside clip ${dep}'s) is dropped when clip ${dep} fails and kept when it is written; clip ${dep} does not wait on it`,
    );
  else fail(`apply's live check: ${liveWrong}`);

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
  const live = (w: Write) => liveWrite(w, failedRows);
  /** Fails a write whose dependency failed, naming it; true when it did. */
  const dependencyFailed = (w: Write) => {
    const dep = failedDependency(w, failedRows);
    // Already failed and reported in an earlier loop.
    if (dep === null || w.rows.every((r) => failedRows.has(r))) return false;
    failRow(
      w.rows[0]!,
      `clip ${dep} failed or was not written, and this clip's voice was planned beside clip ${dep}'s; nothing written for this clip, and the next run plans it again`,
    );
    return true;
  };

  // 1. Each new clip: the local file must hash to the index md5, then upload.
  for (const w of plan.writes) {
    if ((w.kind !== "insert_voice" && w.kind !== "update_voice") || !w.clip)
      continue;
    if (!live(w)) {
      dependencyFailed(w);
      continue;
    }
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
    if (!live(w)) {
      dependencyFailed(w);
      continue;
    }
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

/**
 * The clip a voice to describe has: the library file while it is not
 * uploaded, else the bucket object the voice row holds. Null when neither
 * is there.
 */
async function readClip(
  supabase: SupabaseClient,
  library: string,
  clip: NonNullable<Describe["clip"]>,
): Promise<ClipAudio | null> {
  if (clip.file) {
    const p = localPath(library, clip.file);
    if (!p || !existsSync(p)) return null;
    return {
      bytes: new Uint8Array(await readFile(p)),
      mimeType: clipContentType(clip.file),
    };
  }
  const bytes = await downloadClip(supabase, clipObjectPath(clip.object));
  return bytes ? { bytes, mimeType: clipContentType(clip.object) } : null;
}

/** --describe: one lookup per key with nothing stored, each stored. */
async function describeAll(
  supabase: SupabaseClient,
  plan: Plan,
  library: string,
): Promise<string[]> {
  const { getGeminiClient } = await import("~/lib/gemini-client");
  const gemini = getGeminiClient();
  const failures: string[] = [];
  const needed = lookupsNeeded(plan);
  console.log(`\nDescribing ${needed.length} voice(s):`);
  for (const d of needed) {
    const key = `${d.key.character_id} in ${d.key.work_id}`;
    const clip = d.clip;
    const result = await lookUpVoice(gemini, d, {
      loadClip: clip ? () => readClip(supabase, library, clip) : undefined,
    });
    if (!result.ok) {
      failures.push(`${key}: ${result.reasons.join("; then ")}`);
      console.log(`  ! ${key}: not stored (${result.reasons.join("; then ")})`);
      continue;
    }
    await insertVoiceLookup(supabase, d.key, result.answer, result.model);
    const source =
      result.answer.inferred_from === CLIP_MARK
        ? `described from: ${CLIP_MARK}`
        : `model names the actor: ${result.answer.actor}${result.answer.inferred_from ? `\n      inferred from: ${result.answer.inferred_from}` : ""}`;
    console.log(
      `  ${key} (${d.character}, ${d.work.title} ${d.work.year}${d.voice_actor ? `, ${d.voice_actor}` : ""})\n      ${source}\n      ${result.answer.description}\n      labels: ${labelText(result.answer.labels)}`,
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
    ? await describeAll(supabase, plan, args.library)
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

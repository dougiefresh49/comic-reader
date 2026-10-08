#!/usr/bin/env node

/**
 * Backfill joined balloons (#451) on an issue from a confirmed list, and
 * render each group as one clip.
 *
 * The list is the labels file the #451 bench scored against
 * (`issue-451/bench/labels.json` on the `verification-artifacts` branch): an
 * array of `{ group, page, verdict: "J" | "N", bubbles: uuid[] }`. Only
 * `verdict: "J"` entries are groups.
 *
 * The default run is a dry run: SELECTs only. It prints each group's
 * members, their current `group_id` and audio, the joined text and the
 * characters a render would bill, then totals. `--execute` writes
 * `group_id` (free; each balloon keeps its own clip until the group renders,
 * decision row 386). `--render` renders every group whose members do not
 * yet share the lead's clip, through `renderGroupAudio`, the audio step's
 * own render; it is paid, so it runs only under `LIVE_API_OK=1`.
 *
 * Usage:
 *   pnpm backfill-balloon-groups -- --book <id> --issue <id> --labels <file>
 *     [--group G17 [--group G18,G1]] [--execute] [--render]
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { groupLeadId, joinGroupText } from "~/lib/balloon-groups";
import { loadBookCast, renderVoice } from "~/lib/cast";
import { isDryRun } from "~/lib/fakes/dry-run";
import { renderGroupAudio } from "~/lib/render-group-audio";
import { buildTtsRequest } from "~/lib/tts-request";
import { loadVoiceOverrides } from "~/lib/voice-overrides";
import { supabase } from "./lib/supabase.js";

const HELP = `
Usage: pnpm backfill-balloon-groups -- --book <id> --issue <id> --labels <file> [options]

  --book <id>        book_id, e.g. tmnt-mmpr-iii
  --issue <id>       issue_id, e.g. issue-1
  --labels <file>    JSON array of { group, page, verdict, bubbles }; only
                     verdict "J" entries are groups.
  --group <names>    Only these groups (G17, or G17,G18). Repeatable.
  --execute          Write group_id on the members. Free. Each balloon keeps
                     its own clip until its group renders.
  --render           Render each group whose members do not share the lead's
                     clip yet: one ElevenLabs call per group. Paid: runs only
                     as LIVE_API_OK=1 pnpm backfill-balloon-groups ...
  -h, --help         This text.

Default is a dry run: SELECTs only, nothing written or spent.
`;

const PAID_MESSAGE =
  "Paid: --render makes one ElevenLabs call per group. Re-run it as LIVE_API_OK=1 pnpm backfill-balloon-groups ... only if the task named that spend.";

interface Args {
  book?: string;
  issue?: string;
  labels?: string;
  groups: string[];
  execute: boolean;
  render: boolean;
}

interface Label {
  group: string;
  page: number;
  verdict: "J" | "N";
  bubbles: string[];
}

interface Row {
  id: string;
  legacy_id: string | null;
  page_number: number;
  sort_order: number;
  character_id: string | null;
  ocr_text: string | null;
  text_with_cues: string | null;
  group_id: string | null;
  audio_storage_path: string | null;
  ignored: boolean;
  silent: boolean;
}

const ROW_COLUMNS =
  "id, legacy_id, page_number, sort_order, character_id, ocr_text, text_with_cues, group_id, audio_storage_path, ignored, silent";

function fail(message: string): never {
  console.error(`❌ ${message}`);
  process.exit(1);
}

function takeValue(argv: string[], i: number, flag: string): string {
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) fail(`${flag} needs a value`);
  return v;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { groups: [], execute: false, render: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a || a === "--") continue;
    if (a === "-h" || a === "--help") {
      console.log(HELP);
      process.exit(0);
    } else if (a === "--book") args.book = takeValue(argv, i++, a);
    else if (a === "--issue") args.issue = takeValue(argv, i++, a);
    else if (a === "--labels") args.labels = takeValue(argv, i++, a);
    else if (a === "--group")
      args.groups.push(
        ...takeValue(argv, i++, a)
          .split(",")
          .map((g) => g.trim())
          .filter(Boolean),
      );
    else if (a === "--execute") args.execute = true;
    else if (a === "--render") args.render = true;
    else fail(`Unknown flag '${a}'. Run with --help.`);
  }
  return args;
}

async function readLabels(path: string): Promise<Label[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    fail(`${path}: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) fail(`${path} is not a JSON array.`);
  return parsed.map((raw: unknown, i) => {
    const l = raw as Partial<Label>;
    if (
      typeof l.group !== "string" ||
      typeof l.page !== "number" ||
      (l.verdict !== "J" && l.verdict !== "N") ||
      !Array.isArray(l.bubbles) ||
      !l.bubbles.every((b) => typeof b === "string")
    )
      fail(`${path} entry ${i} is not { group, page, verdict, bubbles }.`);
    return l as Label;
  });
}

async function readRows(
  bookId: string,
  issueId: string,
  ids: string[],
): Promise<Map<string, Row>> {
  const out = new Map<string, Row>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabase
      .from("bubbles")
      .select(ROW_COLUMNS)
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .in("id", ids.slice(i, i + 100));
    if (error) fail(`bubbles: ${error.message}`);
    for (const r of (data ?? []) as Row[]) out.set(r.id, r);
  }
  return out;
}

/** Rows outside the list that hold this group id already. */
async function othersInGroup(
  bookId: string,
  issueId: string,
  groupId: string,
  members: string[],
): Promise<string[]> {
  const { data, error } = await supabase
    .from("bubbles")
    .select("id")
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("group_id", groupId);
  if (error) fail(`bubbles: ${error.message}`);
  return ((data ?? []) as { id: string }[])
    .map((r) => r.id)
    .filter((id) => !members.includes(id));
}

const textOf = (r: Row) => (r.text_with_cues ?? r.ocr_text ?? "").trim();
const clip40 = (s: string) => {
  const flat = s.replace(/\s+/g, " ");
  return flat.length > 40 ? `${flat.slice(0, 40)}…` : flat;
};

/** Why `--execute` refuses a group, or null when it may write it. */
async function conflictOf(
  bookId: string,
  issueId: string,
  label: Label,
  rows: Map<string, Row>,
): Promise<string | null> {
  const missing = label.bubbles.filter((id) => !rows.has(id));
  if (missing.length > 0) return `not in this issue: ${missing.join(", ")}`;
  const members = label.bubbles.map((id) => rows.get(id)!);
  // An ignored or silent balloon is never a group member (#451).
  const unvoiced = members.filter((r) => r.ignored || r.silent);
  if (unvoiced.length > 0)
    return `ignored or silent: ${unvoiced.map((r) => r.legacy_id ?? r.id).join(", ")}`;
  const ids = [...new Set(members.flatMap((r) => r.group_id ?? []))];
  if (ids.length > 1)
    return `members already hold different group_ids: ${members
      .map((r) => `${r.legacy_id ?? r.id}=${r.group_id ?? "null"}`)
      .join(", ")}`;
  if (ids[0]) {
    const extra = await othersInGroup(bookId, issueId, ids[0], label.bubbles);
    if (extra.length > 0)
      return `group_id ${ids[0]} is also held by rows outside this group: ${extra.join(", ")}`;
  }
  return null;
}

/** Members in play order with the lead first, as `renderGroupAudio` reads them. */
function ordered(label: Label, rows: Map<string, Row>): Row[] {
  return label.bubbles
    .flatMap((id) => rows.get(id) ?? [])
    .sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id));
}

/** Whether the members already play one clip: every one holds the lead's path. */
function rendered(members: Row[]): boolean {
  if (members.length < 2) return false;
  const leadId = groupLeadId(
    members.map((m) => ({ id: m.id, sortOrder: m.sort_order })),
  );
  const lead = members.find((m) => m.id === leadId)!;
  return (
    !!lead.audio_storage_path &&
    members.every((m) => m.audio_storage_path === lead.audio_storage_path)
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.book || !args.issue || !args.labels)
    fail("--book, --issue and --labels are required. Run with --help.");
  const bookId = args.book;
  const issueId = args.issue;
  if (args.render && process.env.LIVE_API_OK !== "1") fail(PAID_MESSAGE);
  if (args.render && isDryRun())
    fail(
      "DRY_RUN is set, so --render would store silent audio on a real book. Unset it.",
    );

  let labels = (await readLabels(args.labels)).filter((l) => l.verdict === "J");
  if (args.groups.length > 0) {
    const unknown = args.groups.filter(
      (g) => !labels.some((l) => l.group === g),
    );
    if (unknown.length > 0)
      fail(
        `No verdict "J" group named ${unknown.join(", ")} in ${args.labels}.`,
      );
    labels = labels.filter((l) => args.groups.includes(l.group));
  }

  const rows = await readRows(
    bookId,
    issueId,
    labels.flatMap((l) => l.bubbles),
  );
  const book = await loadBookCast(supabase, bookId);

  // ---------------------------------------------------------------- plan
  console.log(
    `\nbackfill-balloon-groups — ${bookId} / ${issueId}: ${labels.length} groups from ${args.labels}\n`,
  );
  let totalMembers = 0;
  let totalChars = 0;
  let toRender = 0;
  const conflicts = new Map<string, string>();
  for (const label of labels) {
    const members = ordered(label, rows);
    const conflict = await conflictOf(bookId, issueId, label, rows);
    if (conflict) conflicts.set(label.group, conflict);
    console.log(`${label.group}  page ${label.page}`);
    for (const m of members) {
      console.log(
        `  ${m.legacy_id ?? m.id}  "${clip40(textOf(m))}"  group_id=${m.group_id ?? "null"}  audio=${m.audio_storage_path ?? "null"}${m.silent ? "  SILENT" : ""}${m.ignored ? "  IGNORED" : ""}`,
      );
    }
    const text = joinGroupText(members.map(textOf));
    let chars = text.length;
    let voiceNote = "";
    const leadId =
      members.length > 0
        ? groupLeadId(
            members.map((m) => ({ id: m.id, sortOrder: m.sort_order })),
          )
        : null;
    const lead = members.find((m) => m.id === leadId);
    const voice = renderVoice(book, lead?.character_id ?? null, issueId);
    if (voice.ok) {
      const overrides = await loadVoiceOverrides(supabase, [
        voice.elevenLabsId,
      ]);
      chars = buildTtsRequest({
        text,
        voiceId: voice.elevenLabsId,
        override: overrides.get(voice.elevenLabsId),
      }).text.length;
    } else {
      voiceNote = `  (no voice: ${voice.detail})`;
    }
    console.log(`  joined: "${text}"`);
    console.log(`  ${chars} characters${voiceNote}`);
    if (conflict) console.log(`  CONFLICT, --execute skips it: ${conflict}`);
    const done = rendered(members);
    if (done)
      console.log(`  already plays one clip: ${lead?.audio_storage_path}`);
    console.log("");
    totalMembers += members.length;
    if (!done && !conflict) {
      toRender++;
      totalChars += chars;
    }
  }
  console.log(
    `Totals: ${labels.length} groups, ${totalMembers} members, ${toRender} groups to render, ${totalChars} characters to render, ${conflicts.size} conflicts.`,
  );

  if (!args.execute && !args.render) {
    console.log(
      "\nDry run. Nothing was written or spent. --execute writes group_id; --render renders (paid).",
    );
    return;
  }

  // ------------------------------------------------------------- execute
  const touchedPages = new Set<number>();
  if (args.execute) {
    console.log("\nWriting group_id:");
    for (const label of labels) {
      const conflict = conflicts.get(label.group);
      if (conflict) {
        console.log(`  ${label.group}: skipped (${conflict})`);
        continue;
      }
      const members = ordered(label, rows);
      const target = members.find((m) => m.group_id)?.group_id ?? randomUUID();
      const todo = members.filter((m) => m.group_id !== target);
      if (todo.length === 0) {
        console.log(`  ${label.group}: already grouped as ${target}`);
        continue;
      }
      const { data, error } = await supabase
        .from("bubbles")
        .update({ group_id: target })
        .eq("book_id", bookId)
        .eq("issue_id", issueId)
        .in(
          "id",
          todo.map((m) => m.id),
        )
        .is("group_id", null)
        .select("id");
      if (error) fail(`${label.group}: ${error.message}`);
      touchedPages.add(label.page);
      console.log(
        `  ${label.group}: group_id ${target} on ${(data ?? []).length} of ${todo.length} ungrouped members (${members.length} in all)`,
      );
    }
  }

  // -------------------------------------------------------------- render
  if (args.render) {
    console.log("\nRendering (paid):");
    const fresh = await readRows(
      bookId,
      issueId,
      labels.flatMap((l) => l.bubbles),
    );
    let spent = 0;
    for (const label of labels) {
      const conflict = conflicts.get(label.group);
      if (conflict) {
        console.log(`  ${label.group}: skipped, CONFLICT (${conflict})`);
        continue;
      }
      const members = ordered(label, fresh);
      const ids = [...new Set(members.map((m) => m.group_id))];
      if (
        members.length !== label.bubbles.length ||
        ids.length !== 1 ||
        !ids[0]
      ) {
        console.log(
          `  ${label.group}: skipped, its members do not share one group_id yet (run --execute)`,
        );
        continue;
      }
      if (rendered(members)) {
        console.log(`  ${label.group}: already plays one clip`);
        continue;
      }
      const result = await renderGroupAudio({
        client: supabase,
        bookId,
        issueId,
        groupId: ids[0],
        step: "backfill:group-balloons",
        book,
      });
      if ("rendered" in result) {
        spent += result.characters;
        touchedPages.add(label.page);
        console.log(
          `  ${label.group}: ${result.path}  ${result.characters} characters`,
        );
      } else {
        console.log(
          `  ${label.group}: skipped, ${result.skipped}${"memberId" in result ? ` (${result.memberId})` : ""}${"detail" in result ? ` (${result.detail})` : ""}`,
        );
      }
    }
    console.log(`Rendered ${spent} characters in total.`);
  }

  // ---------------------------------------------------------- revalidate
  // `revalidateReaderPages` needs the Next.js runtime, so a script reaches
  // it through the app's /api/revalidate route, as apply-fixes does.
  if (touchedPages.size === 0) return;
  const pages = [...touchedPages].sort((a, b) => a - b).join(", ");
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL;
  const secret = process.env.REVALIDATE_SECRET;
  if (baseUrl && secret) {
    const res = await fetch(`${baseUrl}/api/revalidate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-revalidate-secret": secret,
      },
      body: JSON.stringify({ bookId, issueId }),
    });
    console.log(
      res.ok
        ? `\nReader pages revalidated (pages ${pages} changed).`
        : `\nRevalidate failed: ${res.status} ${await res.text()}`,
    );
  } else {
    console.log(
      `\nPages ${pages} changed. NEXT_PUBLIC_BASE_URL is not set, so nothing was revalidated. Run:\n` +
        `  curl -X POST <app-url>/api/revalidate -H 'content-type: application/json' -H "x-revalidate-secret: $REVALIDATE_SECRET" -d '{"bookId":"${bookId}","issueId":"${issueId}"}'`,
    );
  }
}

main().catch((e) => {
  console.error("❌ backfill-balloon-groups:", e);
  process.exit(1);
});

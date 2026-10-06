#!/usr/bin/env node

/**
 * SELECT-only evidence for the render chain (`renderVoice` in `~/lib/cast`,
 * #429): resolves every bubble of one issue by its `character_id` and counts
 * the outcomes, then prints the forms (characters with `form_of`) and the
 * voice the chain gives them, and runs the form and "no audio" rules on an
 * in-memory copy of the book's cast. Calls nothing paid and writes nothing.
 *
 * `--baseline`: one line per bubble of issues 1 and 2, the bubble id and the
 * ElevenLabs id the chain renders with ("none" when it gives none). #429's
 * gate compares this output before and after the switch, line for line.
 *
 * Usage: tsx --env-file=.env scripts/compare-voice-lookup.ts [--book <id>] [--issue <id>]
 *        tsx --env-file=.env scripts/compare-voice-lookup.ts --baseline [--book <id>]
 */

import {
  loadBookCast,
  renderVoice,
  type BookCast,
  type CastRow,
} from "~/lib/cast";
import { supabase } from "./lib/supabase.js";

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

const bookId = flag("--book", "tmnt-mmpr-iii");
const issueId = flag("--issue", "issue-1");

interface Bubble {
  id: string;
  speaker: string | null;
  character_id: string | null;
  page_number: number;
  sort_order: number;
}

async function readBubbles(issue = issueId): Promise<Bubble[]> {
  const out: Bubble[] = [];
  for (;;) {
    const { data, error } = await supabase
      .from("bubbles")
      .select("id, speaker, character_id, page_number, sort_order")
      .eq("book_id", bookId)
      .eq("issue_id", issue)
      .order("page_number")
      .order("sort_order")
      .order("id")
      .range(out.length, out.length + 999);
    if (error) throw new Error(`reading bubbles: ${error.message}`);
    if (!data || data.length === 0) return out;
    out.push(...(data as Bubble[]));
  }
}

/** One line per bubble of issues 1 and 2: the bubble id and the ElevenLabs id the chain renders with. */
async function baseline(): Promise<void> {
  const book = await loadBookCast(supabase, bookId);
  for (const issue of ["issue-1", "issue-2"]) {
    for (const b of await readBubbles(issue)) {
      const found = renderVoice(book, b.character_id, issue);
      console.log(`${issue} ${b.id} ${found.ok ? found.elevenLabsId : "none"}`);
    }
  }
}

const describe = (found: ReturnType<typeof renderVoice>) =>
  found.ok
    ? `voice ${found.elevenLabsId} (character ${found.characterId}, from ${found.from})`
    : `${found.reason} (${found.detail})`;

async function main(): Promise<void> {
  if (process.argv.includes("--baseline")) return baseline();
  const [book, bubbles] = await Promise.all([
    loadBookCast(supabase, bookId),
    readBubbles(),
  ]);
  const issueRows = book.rows.filter((r) => r.issue_id === issueId);

  console.log(`${bookId}/${issueId}`);
  console.log(
    `castlist rows: ${issueRows.length} in this issue, ${book.rows.length} in the book; ` +
      `with character_id: ${issueRows.filter((r) => r.character_id).length} in this issue`,
  );
  console.log(
    `bubbles: ${bubbles.length}; with character_id: ${bubbles.filter((b) => b.character_id).length}`,
  );
  const outcomes = new Map<string, number>();
  const misses: string[] = [];
  for (const b of bubbles) {
    const found = renderVoice(book, b.character_id, issueId);
    const key = found.ok
      ? found.from === found.characterId
        ? "voice"
        : "voice via form_of"
      : found.reason;
    outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
    if (!found.ok)
      misses.push(
        `  p${b.page_number}#${b.sort_order} ${b.id} speaker=${JSON.stringify(b.speaker)}: ${describe(found)}`,
      );
  }
  console.log(`render chain outcomes:`);
  for (const [k, n] of [...outcomes].sort()) console.log(`  ${n}\t${k}`);
  console.log(`bubbles with no voice: ${misses.length}`);
  for (const m of misses) console.log(m);

  console.log(`\nforms (form_of) with no voice of their own:`);
  let forms = 0;
  for (const [id, other] of [...book.formOf].sort()) {
    if (!other || other === id) continue;
    const found = renderVoice(book, id, issueId);
    if (found.ok && found.from === id) continue;
    forms++;
    const lines = bubbles.filter((b) => b.character_id === id).length;
    console.log(
      `  ${id} -> form_of ${other}: ${describe(found)}, bubbles: ${lines}`,
    );
  }
  if (forms === 0) console.log("  none in the database");

  // The form and "no audio" rules on an in-memory copy of the book's cast:
  // forms with a voiceless castlist row and `form_of` pointing at a voiced
  // character. Nothing is written.
  const donorRow = issueRows.find(
    (r) => r.character_id && r.voice_uuid && !r.no_audio && r.in_issue,
  );
  if (!donorRow?.character_id) return;
  const donor = donorRow.character_id;
  const form = (id: string, patch: Partial<CastRow> = {}): CastRow => ({
    issue_id: issueId,
    display_name: id,
    character_id: id,
    voice_uuid: null,
    in_issue: true,
    no_audio: false,
    ...patch,
  });
  const synthetic: BookCast = {
    ...book,
    rows: [
      ...book.rows,
      form("synthetic-form"),
      form("synthetic-silent-form", { no_audio: true }),
      form("synthetic-removed-form", { in_issue: false }),
    ],
    formOf: new Map([
      ...book.formOf,
      ["synthetic-form", donor],
      ["synthetic-silent-form", donor],
      ["synthetic-removed-form", donor],
    ]),
  };
  console.log(
    `\nsynthetic (in memory, not in the database): form_of -> ${donor} (voice ${donorRow.voice_uuid})`,
  );
  for (const id of [
    "synthetic-form",
    "synthetic-silent-form",
    "synthetic-removed-form",
  ])
    console.log(`  ${id}: ${describe(renderVoice(synthetic, id, issueId))}`);
  console.log(
    `  null character_id: ${describe(renderVoice(synthetic, null, issueId))}`,
  );
}

main().catch((e) => {
  console.error("compare-voice-lookup:", e);
  process.exit(1);
});

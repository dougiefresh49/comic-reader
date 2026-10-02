#!/usr/bin/env node

/**
 * SELECT-only evidence for #352: resolves every bubble of one issue two ways,
 * the audio step's old name rule (`planBubblesToSend`: alias, then slug, then
 * the issue's castlist voice) and the new `lookupVoice` (bubble
 * `character_id`, castlist `character_id`, name rule; voice from `voiceFor`),
 * and prints every bubble where the two disagree. Then prints the forms
 * (characters with `voice_of`) whose own castlist voice is null, and the voice
 * `voiceFor` gives them. Calls nothing paid and writes nothing.
 *
 * Usage: tsx --env-file=.env scripts/compare-voice-lookup.ts [--book <id>] [--issue <id>]
 */

import { loadBookCast, voiceFor, type BookCast } from "~/lib/cast";
import { slugify } from "~/lib/character-id";
import {
  buildAliasMap,
  buildCastIndex,
  lookupVoice,
  planBubblesToSend,
  voiceLookupContext,
  type BubbleAudioRow,
} from "~/workflows/steps/audio-plan";
import { supabase } from "./lib/supabase.js";

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

const bookId = flag("--book", "tmnt-mmpr-iii");
const issueId = flag("--issue", "issue-1");

type Bubble = BubbleAudioRow & {
  character_id: string | null;
  page_number: number;
  sort_order: number;
};

async function readBubbles(): Promise<Bubble[]> {
  const out: Bubble[] = [];
  for (;;) {
    const { data, error } = await supabase
      .from("bubbles")
      .select(
        "id, speaker, character_id, ignored, silent, audio_storage_path, text_with_cues, ocr_text, page_number, sort_order",
      )
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .order("page_number")
      .order("sort_order")
      .order("id")
      .range(out.length, out.length + 999);
    if (error) throw new Error(`reading bubbles: ${error.message}`);
    if (!data || data.length === 0) return out;
    out.push(...(data as Bubble[]));
  }
}

async function main(): Promise<void> {
  const [book, aliases, bubbles] = await Promise.all([
    loadBookCast(supabase, bookId),
    supabase
      .from("aliases")
      .select("alias, canonical")
      .or(`scope.eq.global,and(scope.eq.book,scope_id.eq.${bookId})`),
    readBubbles(),
  ]);
  if (aliases.error)
    throw new Error(`reading aliases: ${aliases.error.message}`);
  const aliasRows = (aliases.data ?? []) as {
    alias: string;
    canonical: string;
  }[];
  const issueRows = book.rows.filter((r) => r.issue_id === issueId);

  // Old: the audio step before #352, on the issue's castlist only.
  const oldAliasMap = buildAliasMap(aliasRows);
  const oldCast = buildCastIndex(issueRows);
  const oldVoice = (b: Bubble): string => {
    // Only the voice part of the rule: the bubble as if it needed audio.
    const plan = planBubblesToSend(
      [
        {
          ...b,
          ignored: false,
          silent: false,
          audio_storage_path: null,
          text_with_cues: "x",
        },
      ],
      oldAliasMap,
      oldCast,
    );
    const sent = plan.toSend[0];
    return sent ? sent.voiceId : `(${plan.skipped[0]!.reason})`;
  };

  const ctx = voiceLookupContext(book, issueId, aliasRows);
  const sources = new Map<string, number>();
  const disagreements: string[] = [];
  for (const b of bubbles) {
    const before = oldVoice(b);
    const found = lookupVoice(ctx, b);
    const after = found.ok ? found.voiceId : `(${found.reason})`;
    const key = `${found.ok ? "voice" : found.reason} via ${found.source ?? "-"}`;
    sources.set(key, (sources.get(key) ?? 0) + 1);
    if (before === after) continue;
    disagreements.push(
      `  p${b.page_number}#${b.sort_order} ${b.id}` +
        ` speaker=${JSON.stringify(b.speaker)} character_id=${b.character_id ?? "null"}` +
        `${b.ignored ? " [ignored]" : ""}${b.silent ? " [silent]" : ""}\n` +
        `      old: ${before}\n` +
        `      new: ${after} via ${found.source ?? "-"}` +
        (found.ok
          ? ` (character ${found.characterId ?? "-"}, voice from ${found.from ?? "-"})`
          : ` (${found.detail})`),
    );
  }

  console.log(`${bookId}/${issueId}`);
  console.log(
    `castlist rows: ${issueRows.length} in this issue, ${book.rows.length} in the book; ` +
      `with character_id: ${issueRows.filter((r) => r.character_id).length} in this issue`,
  );
  console.log(
    `bubbles: ${bubbles.length}; with character_id: ${bubbles.filter((b) => b.character_id).length}`,
  );
  console.log(`slug conflicts in this issue: ${ctx.cast.conflicts.length}`);
  console.log(`new lookup outcomes:`);
  for (const [k, n] of [...sources].sort()) console.log(`  ${n}\t${k}`);
  console.log(`disagreements (old vs new): ${disagreements.length}`);
  for (const d of disagreements) console.log(d);

  console.log(`\nforms whose own castlist voice is null (voice_of):`);
  let forms = 0;
  for (const [id, other] of [...book.voiceOf].sort()) {
    if (!other || other === id) continue;
    const voice = voiceFor(book, id, issueId);
    if (voice && voice.from === id) continue; // has a voice of its own
    const ownRows = issueRows.filter(
      (r) =>
        r.character_id === id ||
        (r.character_id === null &&
          (book.resolve(r.character)?.id ?? "") === id),
    );
    const lines = bubbles.filter(
      (b) => lookupVoice(ctx, b).characterId === id,
    ).length;
    forms++;
    console.log(
      `  ${id} -> voice_of ${other}: own castlist rows here ` +
        `[${ownRows.map((r) => `${r.character}=${r.voice_id ?? "null"}`).join(", ") || "none"}], ` +
        `voiceFor = ${voice ? `${voice.voiceId} (from ${voice.from})` : "null"}, ` +
        `bubbles resolved to it: ${lines}`,
    );
  }
  if (forms === 0) console.log("  none in the database");

  // No `characters` row has `voice_of` in prod yet, so the form case also runs
  // on an in-memory copy of this book's cast: one added form with a null-voice
  // castlist row and `voice_of` pointing at a voiced character. Nothing is written.
  const donorRow = issueRows.find(
    (r) => r.voice_id && r.voice_id !== "__SKIPPED__",
  );
  if (!donorRow) return;
  const donor =
    book.resolve(donorRow.character)?.id ?? slugify(donorRow.character);
  const form = (id: string, voice_id: string | null) => ({
    issue_id: issueId,
    character: id,
    character_id: id,
    voice_id,
    voice_uuid: null,
    in_issue: true,
  });
  const synthetic: BookCast = {
    ...book,
    rows: [
      ...book.rows,
      form("synthetic-form", null),
      form("synthetic-silent-form", "__SKIPPED__"),
    ],
    voiceOf: new Map([
      ...book.voiceOf,
      ["synthetic-form", donor],
      ["synthetic-silent-form", donor],
    ]),
  };
  const sctx = voiceLookupContext(synthetic, issueId, aliasRows);
  console.log(
    `\nsynthetic (in memory, not in the database): voice_of -> ${donor} (${donorRow.character}=${donorRow.voice_id})`,
  );
  for (const [label, bubble] of [
    [
      "bubble character_id",
      { speaker: "someone else", character_id: "synthetic-form" },
    ],
    [
      "castlist character_id",
      { speaker: "Synthetic Form", character_id: null },
    ],
    [
      "no audio this run",
      { speaker: null, character_id: "synthetic-silent-form" },
    ],
  ] as const) {
    const found = lookupVoice(sctx, bubble);
    console.log(
      `  ${label}: ` +
        (found.ok
          ? `voice ${found.voiceId} via ${found.source}, character ${found.characterId}, from ${found.from}`
          : `${found.reason} via ${found.source} (${found.detail})`),
    );
  }
}

main().catch((e) => {
  console.error("compare-voice-lookup:", e);
  process.exit(1);
});

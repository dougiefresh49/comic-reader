// Re-voice (#836): which of a book's bubbles still play audio from a voice
// their character no longer has, grouped into the renders that would replace
// it. SELECTs only; the renders go through the review editor's Regenerate.
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { joinGroupText } from "~/lib/balloon-groups";
import { chunk } from "~/lib/chunk";
import { castRow, loadBookCast, renderVoice, type BookCast } from "~/lib/cast";
import { buildTtsRequest } from "~/lib/tts-request";
import { loadVoiceOverrides } from "~/lib/voice-overrides";
import type { RevoicePlan, RevoiceUnit } from "./types";

interface AudioRow {
  id: string;
  issue_id: string;
  page_number: number;
  sort_order: number;
  character_id: string;
  voice_id: string | null;
  group_id: string | null;
  text_with_cues: string | null;
  ocr_text: string | null;
}

const PAGE = 1000;

async function readAudioRows(
  client: SupabaseClient,
  bookId: string,
  characterIds: string[] | undefined,
): Promise<AudioRow[]> {
  const out: AudioRow[] = [];
  for (;;) {
    let q = client
      .from("bubbles")
      .select(
        "id, issue_id, page_number, sort_order, character_id, voice_id, group_id, text_with_cues, ocr_text",
      )
      .eq("book_id", bookId)
      .not("audio_storage_path", "is", null)
      .not("character_id", "is", null)
      .eq("ignored", false)
      .eq("silent", false);
    if (characterIds) q = q.in("character_id", characterIds);
    const { data, error } = await q
      .order("id")
      .range(out.length, out.length + PAGE - 1);
    if (error) throw new Error(`re-voice: reading bubbles: ${error.message}`);
    const rows = (data ?? []) as AudioRow[];
    if (rows.length === 0) return out;
    out.push(...rows);
  }
}

/**
 * The done casting moves that swapped a voice in for a different one, by
 * `character:voice`. A swap writes its own issue's castlist row and the later
 * ones' (`castVoiceInBook`), so `from` holds the first issue it covers. A
 * `stand_in` writes only its own issue's row (`setIssueVoice`): `only` holds
 * `character:voice@issue`, and `standIns` the `character:voice`, since an
 * issue with no voice of its own inherits the book's latest one.
 */
interface Swaps {
  from: Map<string, number>;
  only: Set<string>;
  standIns: Set<string>;
}

async function readSwaps(
  client: SupabaseClient,
  book: BookCast,
): Promise<Swaps> {
  const out: Swaps = { from: new Map(), only: new Set(), standIns: new Set() };
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from("casting_moves")
      .select("kind, issue_id, character_id, voice_uuid, replaces_voice_uuid")
      .eq("book_id", book.bookId)
      .eq("status", "done")
      .not("character_id", "is", null)
      .not("voice_uuid", "is", null)
      .not("replaces_voice_uuid", "is", null)
      .order("id")
      .range(from, from + PAGE - 1);
    if (error)
      throw new Error(`re-voice: reading casting moves: ${error.message}`);
    const rows = (data ?? []) as {
      kind: string;
      issue_id: string;
      character_id: string;
      voice_uuid: string;
      replaces_voice_uuid: string;
    }[];
    for (const m of rows) {
      if (m.replaces_voice_uuid === m.voice_uuid) continue;
      const key = `${m.character_id}:${m.voice_uuid}`;
      if (m.kind === "stand_in") {
        out.only.add(`${key}@${m.issue_id}`);
        out.standIns.add(key);
        continue;
      }
      const n = book.issueNumber.get(m.issue_id) ?? 0;
      out.from.set(key, Math.min(n, out.from.get(key) ?? n));
    }
    if (rows.length < PAGE) return out;
  }
}

/** The active (not ignored, not silent) members of joined groups, by `issue:group`, in sort order. */
async function readGroupMembers(
  client: SupabaseClient,
  bookId: string,
  groups: { issueId: string; groupId: string }[],
): Promise<Map<string, GroupMember[]>> {
  const out = new Map<string, GroupMember[]>();
  for (const issueId of new Set(groups.map((g) => g.issueId))) {
    const ids = groups
      .filter((g) => g.issueId === issueId)
      .map((g) => g.groupId);
    for (const part of chunk(ids, 100)) {
      const { data, error } = await client
        .from("bubbles")
        .select(
          "id, group_id, page_number, sort_order, text_with_cues, ocr_text",
        )
        .eq("book_id", bookId)
        .eq("issue_id", issueId)
        .in("group_id", part)
        .eq("ignored", false)
        .eq("silent", false)
        .order("sort_order")
        .order("id");
      if (error) throw new Error(`re-voice: reading groups: ${error.message}`);
      for (const m of (data ?? []) as (GroupMember & { group_id: string })[]) {
        const key = `${issueId}:${m.group_id}`;
        out.set(key, [...(out.get(key) ?? []), m]);
      }
    }
  }
  return out;
}

type GroupMember = Pick<
  AudioRow,
  "id" | "page_number" | "sort_order" | "text_with_cues" | "ocr_text"
>;

/**
 * Every character in the book with old-voice audio, and the renders that
 * replace it. A bubble's audio is old when:
 *
 * - `bubbles.voice_id` names a voice other than the one `renderVoice` finds
 *   for its character in its issue now; or
 * - `voice_id` is null (audio from before #748 recorded it) and a done
 *   `casting_moves` row swapped the character's current voice in, on this
 *   issue or an earlier one (a stand-in: this issue only). Moves started
 *   after `voice_id` did, and every render since writes `voice_id`, so audio
 *   with no `voice_id` predates every recorded swap.
 *
 * A bubble whose character has no playable voice now is left out: Regenerate
 * could not render it either. A render is what Regenerate makes for the
 * bubble: a joined group (#451) with two or more active members is one
 * render of every active member, priced on their joined text; anything else
 * is the bubble alone. Credits are the request text `buildTtsRequest` makes,
 * voice prefix included.
 */
export async function planRevoice(
  client: SupabaseClient,
  bookId: string,
  opts: { characterIds?: string[]; book?: BookCast } = {},
): Promise<RevoicePlan[]> {
  const [book, rows] = await Promise.all([
    opts.book ?? loadBookCast(client, bookId),
    readAudioRows(client, bookId, opts.characterIds),
  ]);
  const swaps = await readSwaps(client, book);
  const issueNumber = (id: string) => book.issueNumber.get(id) ?? 0;

  const stale: { row: AudioRow; elevenLabsId: string }[] = [];
  for (const row of rows) {
    const now = renderVoice(book, row.character_id, row.issue_id);
    if (!now.ok) continue;
    const key = `${now.from}:${now.voiceUuid}`;
    const swappedAt = swaps.from.get(key);
    const old = row.voice_id
      ? row.voice_id !== now.voiceUuid
      : (swappedAt !== undefined && swappedAt <= issueNumber(row.issue_id)) ||
        swaps.only.has(`${key}@${row.issue_id}`) ||
        // An issue with no voice of its own speaks the stand-in it inherits.
        (swaps.standIns.has(key) &&
          !castRow(book, now.from, row.issue_id)?.voice_uuid);
    if (old) stale.push({ row, elevenLabsId: now.elevenLabsId });
  }
  const [overrides, groups] = await Promise.all([
    loadVoiceOverrides(
      client,
      stale.map((s) => s.elevenLabsId),
    ),
    readGroupMembers(
      client,
      bookId,
      stale.flatMap(({ row }) =>
        row.group_id ? [{ issueId: row.issue_id, groupId: row.group_id }] : [],
      ),
    ),
  ]);

  // One render per bubble, or per joined group: the members share one clip.
  const units = new Map<
    string,
    { members: GroupMember[]; elevenLabsId: string; characterId: string }
  >();
  for (const { row, elevenLabsId } of stale) {
    const members = row.group_id
      ? groups.get(`${row.issue_id}:${row.group_id}`)
      : undefined;
    const joined = members && members.length >= 2;
    const key = joined
      ? `${row.issue_id}:group:${row.group_id}`
      : `${row.issue_id}:${row.id}`;
    if (units.has(key)) continue;
    units.set(key, {
      members: joined ? members : [row],
      elevenLabsId,
      characterId: row.character_id,
    });
  }

  const plans = new Map<string, RevoicePlan>();
  for (const [key, unit] of units) {
    const first = unit.members[0]!;
    const issueId = key.slice(0, key.indexOf(":"));
    const text =
      unit.members.length > 1
        ? joinGroupText(
            unit.members.map((r) =>
              (r.text_with_cues ?? r.ocr_text ?? "").trim(),
            ),
          )
        : (first.text_with_cues ?? first.ocr_text ?? "");
    const credits = buildTtsRequest({
      text,
      voiceId: unit.elevenLabsId,
      override: overrides.get(unit.elevenLabsId),
    }).text.length;
    const plan = plans.get(unit.characterId) ?? {
      characterId: unit.characterId,
      issues: [],
      units: [],
      bubbles: 0,
      credits: 0,
    };
    plans.set(unit.characterId, plan);
    const u: RevoiceUnit = {
      issueId,
      bubbleId: first.id,
      page: first.page_number,
      sortOrder: first.sort_order,
      bubbles: unit.members.length,
      credits,
    };
    plan.units.push(u);
    plan.bubbles += u.bubbles;
    plan.credits += u.credits;
  }

  for (const plan of plans.values()) {
    plan.units.sort(
      (a, b) =>
        issueNumber(a.issueId) - issueNumber(b.issueId) ||
        a.page - b.page ||
        a.sortOrder - b.sortOrder,
    );
    for (const u of plan.units) {
      let issue = plan.issues.find((i) => i.issueId === u.issueId);
      if (!issue) {
        issue = {
          issueId: u.issueId,
          number: issueNumber(u.issueId),
          bubbles: 0,
          credits: 0,
        };
        plan.issues.push(issue);
      }
      issue.bubbles += u.bubbles;
      issue.credits += u.credits;
    }
  }
  return [...plans.values()].sort((a, b) =>
    a.characterId.localeCompare(b.characterId),
  );
}

// Re-voice (#836): which of a book's bubbles still play audio from a voice
// their character no longer has, grouped into the renders that would replace
// it. SELECTs only; the renders go through the review editor's Regenerate.
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { joinGroupText } from "~/lib/balloon-groups";
import { loadBookCast, renderVoice, type BookCast } from "~/lib/cast";
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

/** `character:voice` for every done casting move that put a voice on a character. */
async function readSwappedIn(
  client: SupabaseClient,
  bookId: string,
): Promise<Set<string>> {
  const { data, error } = await client
    .from("casting_moves")
    .select("character_id, voice_uuid")
    .eq("book_id", bookId)
    .eq("status", "done")
    .not("character_id", "is", null)
    .not("voice_uuid", "is", null);
  if (error)
    throw new Error(`re-voice: reading casting moves: ${error.message}`);
  return new Set(
    ((data ?? []) as { character_id: string; voice_uuid: string }[]).map(
      (m) => `${m.character_id}:${m.voice_uuid}`,
    ),
  );
}

/**
 * Every character in the book with old-voice audio, and the renders that
 * replace it. A bubble's audio is old when:
 *
 * - `bubbles.voice_id` names a voice other than the one `renderVoice` finds
 *   for its character in its issue now; or
 * - `voice_id` is null (audio from before #748 recorded it) and a done
 *   `casting_moves` row put the character's current voice in. Moves started
 *   after `voice_id` did, and every render since writes `voice_id`, so audio
 *   with no `voice_id` predates every recorded swap.
 *
 * A bubble whose character has no playable voice now is left out: Regenerate
 * could not render it either. Credits are the request text `buildTtsRequest`
 * makes, voice prefix included, one per render: a joined group (#451) is one.
 */
export async function planRevoice(
  client: SupabaseClient,
  bookId: string,
  opts: { characterIds?: string[]; book?: BookCast } = {},
): Promise<RevoicePlan[]> {
  const [book, rows, swappedIn] = await Promise.all([
    opts.book ?? loadBookCast(client, bookId),
    readAudioRows(client, bookId, opts.characterIds),
    readSwappedIn(client, bookId),
  ]);

  const stale: { row: AudioRow; elevenLabsId: string }[] = [];
  for (const row of rows) {
    const now = renderVoice(book, row.character_id, row.issue_id);
    if (!now.ok) continue;
    const old = row.voice_id
      ? row.voice_id !== now.voiceUuid
      : swappedIn.has(`${now.from}:${now.voiceUuid}`);
    if (old) stale.push({ row, elevenLabsId: now.elevenLabsId });
  }
  const overrides = await loadVoiceOverrides(
    client,
    stale.map((s) => s.elevenLabsId),
  );

  // One render per bubble, or per joined group: the members share one clip.
  const units = new Map<
    string,
    { rows: AudioRow[]; elevenLabsId: string; characterId: string }
  >();
  for (const { row, elevenLabsId } of stale) {
    const key = row.group_id
      ? `${row.issue_id}:group:${row.group_id}`
      : `${row.issue_id}:${row.id}`;
    const unit = units.get(key);
    if (unit) unit.rows.push(row);
    else
      units.set(key, {
        rows: [row],
        elevenLabsId,
        characterId: row.character_id,
      });
  }

  const plans = new Map<string, RevoicePlan>();
  for (const unit of units.values()) {
    unit.rows.sort((a, b) => a.sort_order - b.sort_order);
    const first = unit.rows[0]!;
    const text =
      unit.rows.length > 1
        ? joinGroupText(
            unit.rows.map((r) => (r.text_with_cues ?? r.ocr_text ?? "").trim()),
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
      issueId: first.issue_id,
      bubbleId: first.id,
      page: first.page_number,
      sortOrder: first.sort_order,
      bubbles: unit.rows.length,
      credits,
    };
    plan.units.push(u);
    plan.bubbles += u.bubbles;
    plan.credits += u.credits;
  }

  const issueNumber = (id: string) => book.issueNumber.get(id) ?? 0;
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

import type { SupabaseClient } from "@supabase/supabase-js";
import { slugify } from "~/lib/character-id";
import { listAllIssues } from "~/lib/issue-queries";
import { buildAliasMap, speakerKey } from "~/workflows/steps/audio-plan";
import type { CastlistRow, CharacterRow, IssueTarget, VoiceRow } from "./types";

const PAGE = 1000;

function fail(what: string, error: { message: string }): never {
  throw new Error(`${what}: ${error.message}`);
}

/** Fills the #91 columns with their defaults when a row predates them. */
function toVoiceRow(raw: Record<string, unknown>): VoiceRow {
  const labels = raw.labels;
  return {
    id: String(raw.id),
    display_name: String(raw.display_name),
    status: raw.status as VoiceRow["status"],
    current_elevenlabs_id: (raw.current_elevenlabs_id as string | null) ?? null,
    source_clip_path: (raw.source_clip_path as string | null) ?? null,
    source_clip_md5: (raw.source_clip_md5 as string | null) ?? null,
    design_prompt: (raw.design_prompt as string | null) ?? null,
    description: (raw.description as string | null) ?? null,
    labels:
      labels && typeof labels === "object"
        ? (labels as Record<string, string>)
        : null,
    consumers: Array.isArray(raw.consumers)
      ? (raw.consumers as string[])
      : ["comic"],
    keep_active: Boolean(raw.keep_active),
    created_at: String(raw.created_at),
    archived_at: (raw.archived_at as string | null) ?? null,
  };
}

export async function readVoices(
  supabase: SupabaseClient,
): Promise<VoiceRow[]> {
  const { data, error } = await supabase
    .from("voices")
    .select("*")
    .order("display_name");
  if (error) fail("read voices", error);
  return ((data ?? []) as Record<string, unknown>[]).map(toVoiceRow);
}

/** By row id only, never by display_name (decisions row 153). */
export async function readVoice(
  supabase: SupabaseClient,
  id: string,
): Promise<VoiceRow | null> {
  const res = await supabase.from("voices").select("*").eq("id", id).limit(1);
  if (res.error) fail(`read voice ${id}`, res.error);
  const row = ((res.data ?? []) as Record<string, unknown>[])[0];
  return row ? toVoiceRow(row) : null;
}

export async function readCastlist(
  supabase: SupabaseClient,
  bookId?: string,
): Promise<CastlistRow[]> {
  let q = supabase.from("castlist").select("*");
  if (bookId) q = q.eq("book_id", bookId);
  const { data, error } = await q;
  if (error) fail("read castlist", error);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    book_id: String(r.book_id),
    issue_id: String(r.issue_id),
    character: String(r.character),
    character_id: (r.character_id as string | null) ?? null,
    voice_id: (r.voice_id as string | null) ?? null,
    voice_uuid: (r.voice_uuid as string | null) ?? null,
  }));
}

export function booksUsingVoice(
  voiceId: string,
  castlist: CastlistRow[],
): string[] {
  const books = new Set<string>();
  for (const c of castlist) if (c.voice_uuid === voiceId) books.add(c.book_id);
  return [...books].sort();
}

async function readCharacters(
  supabase: SupabaseClient,
): Promise<CharacterRow[]> {
  const { data, error } = await supabase.from("characters").select("*");
  if (error) fail("read characters", error);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    voice_of: (r.voice_of as string | null) ?? null,
  }));
}

interface NeedBubble {
  character_id: string | null;
  speaker: string | null;
}

/** Every non-ignored bubble of the issue, paged past the 1000-row cap. */
async function readIssueBubbles(
  supabase: SupabaseClient,
  target: IssueTarget,
): Promise<NeedBubble[]> {
  const rows: NeedBubble[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("bubbles")
      .select("character_id, speaker")
      .eq("book_id", target.bookId)
      .eq("issue_id", target.issueId)
      .eq("ignored", false)
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) fail("read bubbles", error);
    const page = (data ?? []) as NeedBubble[];
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

/**
 * The `voices.id` set the target issue needs (decisions row 28): each
 * bubble's `character_id`, or until #100 fills that column its `speaker`
 * through the audio step's alias-then-slug rule, mapped through
 * `coalesce(characters.voice_of, characters.id)` to the book's castlist.
 */
export async function issueNeeds(
  supabase: SupabaseClient,
  target: IssueTarget,
): Promise<Set<string>> {
  const [bubbles, aliasRes, characters, castlist] = await Promise.all([
    readIssueBubbles(supabase, target),
    supabase
      .from("aliases")
      .select("alias, canonical")
      .or(`scope.eq.global,and(scope.eq.book,scope_id.eq.${target.bookId})`),
    readCharacters(supabase),
    readCastlist(supabase, target.bookId),
  ]);
  if (aliasRes.error) fail("read aliases", aliasRes.error);
  const aliasMap = buildAliasMap(
    (aliasRes.data ?? []) as { alias: string; canonical: string }[],
  );
  const voiceOf = new Map(characters.map((c) => [c.id, c.voice_of ?? c.id]));

  const slugs = new Set<string>();
  for (const b of bubbles) {
    const key =
      b.character_id ?? (b.speaker ? speakerKey(b.speaker, aliasMap) : null);
    if (!key) continue;
    slugs.add(voiceOf.get(key) ?? key);
  }

  const needed = new Set<string>();
  for (const c of castlist) {
    if (!c.voice_uuid) continue;
    if (slugs.has(c.character_id ?? slugify(c.character)))
      needed.add(c.voice_uuid);
  }
  return needed;
}

/**
 * Least-recently-used proxy: the newest `issues.created_at` among issues
 * whose castlist rows point at the voice. Null when nothing casts it.
 */
export async function lastUsedByVoice(
  supabase: SupabaseClient,
  castlist: CastlistRow[],
): Promise<Map<string, string | null>> {
  const { data, error } = await listAllIssues(
    supabase,
    "book_id, id, created_at",
  );
  if (error) fail("read issues", error);
  const created = new Map<string, string>();
  for (const i of data ?? []) {
    if (i.created_at) created.set(`${i.book_id}/${i.id}`, i.created_at);
  }
  const last = new Map<string, string | null>();
  for (const c of castlist) {
    if (!c.voice_uuid) continue;
    const at = created.get(`${c.book_id}/${c.issue_id}`) ?? null;
    const prev = last.get(c.voice_uuid);
    if (prev === undefined || (at && (!prev || at > prev)))
      last.set(c.voice_uuid, at);
  }
  return last;
}

// The writes below are #66's `runArchive` and `runRestore` rows, unchanged.

export async function markArchived(
  supabase: SupabaseClient,
  voice: VoiceRow,
  formerElevenLabsId: string,
  archivedForBookId: string | null,
): Promise<void> {
  const upd = await supabase
    .from("voices")
    .update({
      status: "archived",
      current_elevenlabs_id: null,
      archived_at: new Date().toISOString(),
    })
    .eq("id", voice.id);
  if (upd.error) fail("update voices", upd.error);
  const cast = await supabase
    .from("castlist")
    .update({ voice_id: null })
    .eq("voice_uuid", voice.id);
  if (cast.error) fail("update castlist", cast.error);
  const log = await supabase.from("voice_archives").insert({
    voice_id: voice.id,
    former_elevenlabs_id: formerElevenLabsId,
    archived_for_book_id: archivedForBookId,
  });
  if (log.error) fail("insert voice_archives", log.error);
}

export async function markRestored(
  supabase: SupabaseClient,
  voice: VoiceRow,
  newElevenLabsId: string,
): Promise<void> {
  const upd = await supabase
    .from("voices")
    .update({
      status: "active",
      current_elevenlabs_id: newElevenLabsId,
      archived_at: null,
    })
    .eq("id", voice.id);
  if (upd.error) fail("update voices", upd.error);
  const cast = await supabase
    .from("castlist")
    .update({ voice_id: newElevenLabsId })
    .eq("voice_uuid", voice.id);
  if (cast.error) fail("update castlist", cast.error);
}

export async function recordSnapshot(
  supabase: SupabaseClient,
  voiceId: string,
  objectPath: string,
  md5: string,
): Promise<void> {
  const { error } = await supabase
    .from("voices")
    .update({ source_clip_path: objectPath, source_clip_md5: md5 })
    .eq("id", voiceId);
  if (error) fail("update voices", error);
}

export interface RegisterVoiceInput {
  display_name: string;
  current_elevenlabs_id: string;
  description: string | null;
  labels: Record<string, string> | null;
  source_clip_path: string | null;
  source_clip_md5: string | null;
  /** The character the voice is for (#91 column). */
  character_id?: string | null;
  /** A Voice Design voice's prompt, kept for provenance (#96). */
  design_prompt?: string | null;
}

/** Inserts the active row for a voice the module just added. */
export async function registerVoice(
  supabase: SupabaseClient,
  input: RegisterVoiceInput,
): Promise<string> {
  const { data, error } = await supabase
    .from("voices")
    .insert({ ...input, status: "active" })
    .select("id")
    .single();
  if (error) fail("insert voices", error);
  return String((data as { id: string }).id);
}

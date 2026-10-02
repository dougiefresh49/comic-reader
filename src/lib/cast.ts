/**
 * The one home for an issue's cast (#347): the three role ids, the proposed
 * cast (decisions rows 237 and 242), seeding it into `castlist`, the voice rule,
 * add, remove, set a voice, creating and renaming characters, and voice
 * requests (`casting_tasks` rows with an `action`).
 *
 * Every function takes the Supabase client, like `issue-queries.ts`: server
 * code passes `supabaseAdmin`, a workflow step its step client, a script its
 * own. Every `castlist` and `casting_tasks` query filters by book, and by issue
 * when it is about one issue. Every `castlist` write sets `character_id`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "~/types/database";
import { slugify } from "~/lib/character-id";
import { listBookIssues, selectIssue } from "~/lib/issue-queries";
import { SKIPPED_VOICE } from "~/lib/voice-settings";

type Client = SupabaseClient;
const db = (client: Client) => client as SupabaseClient<Database>;

/** The three generic roles; #346 created their `characters` rows. */
export const ROLE_IDS = ["narrator", "off-panel", "crowd"] as const;
export type RoleId = (typeof ROLE_IDS)[number];
export const isRoleId = (id: string): id is RoleId =>
  (ROLE_IDS as readonly string[]).includes(id);

/** Why a name is in the proposed cast. "cast before" is a `castlist` row anywhere in the book. */
export type CastSource = "faces" | "wiki" | "cast before" | "role";

export interface ProposedMember {
  /** A `characters.id`. */
  id: string;
  name: string;
  sources: CastSource[];
  /** Face detections of this character in the issue. */
  faces: number;
  /** The wiki names that brought it in, "Kimberly Hart (Pink Ranger)" style. */
  wikiNames: string[];
  /** The book's `castlist.character` texts that brought it in. */
  castNames: string[];
}

/** A name that matches no `characters` row: shown to the owner, never seeded. */
export interface CastSuggestion {
  name: string;
  qualifier: string;
  source: "wiki" | "cast before";
}

export interface CastProposal {
  members: ProposedMember[];
  suggestions: CastSuggestion[];
}

/** A character's voice: the `voices` row id and the ElevenLabs id, as `castlist` stores them. */
export interface CastVoice {
  voiceUuid: string | null;
  voiceId: string | null;
  /** The character whose castlist row holds it: the character itself, or its `voice_of`. */
  from: string;
}

export interface CastRow {
  issue_id: string;
  character: string;
  character_id: string | null;
  voice_id: string | null;
  voice_uuid: string | null;
  in_issue: boolean;
}

export interface CharacterRow {
  id: string;
  display_name: string | null;
  aliases: string[];
  voice_of: string | null;
}

/** What `voiceFor` and the writers read: the book's castlist, its issue order, `characters.voice_of`, and the name resolver. */
export interface BookCast {
  bookId: string;
  rows: CastRow[];
  issueNumber: Map<string, number>;
  voiceOf: Map<string, string | null>;
  /** The `characters` row a name means: its id, display name or an alias, compared slugified. */
  resolve: (name: string) => CharacterRow | undefined;
}

export type VoiceRequest =
  | { action: "clone"; targetVoiceUuid: string }
  | { action: "design" };

export interface StoredVoiceRequest {
  characterId: string;
  action: "clone" | "design";
  targetVoiceUuid: string | null;
  status: string;
  completedAt: string | null;
}

const PAGE = 1000;

/**
 * Every row of a paged read, or a throw: a cut-short cast is worse than none.
 * Pages by the rows that came back and stops on an empty page, so a server
 * row cap below PAGE cannot cut the read short.
 */
async function readAll<T>(
  what: string,
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (;;) {
    const { data, error } = await page(out.length, out.length + PAGE - 1);
    if (error) throw new Error(`cast: reading ${what}: ${error.message}`);
    const rows = (data ?? []) as T[];
    if (rows.length === 0) return out;
    out.push(...rows);
  }
}

function must(what: string, error: { message: string } | null): void {
  if (error) throw new Error(`cast: ${what}: ${error.message}`);
}

async function readCharacters(client: Client): Promise<CharacterRow[]> {
  return readAll<CharacterRow>("characters", (from, to) =>
    db(client)
      .from("characters")
      .select("id, display_name, aliases, voice_of")
      .order("id")
      .range(from, to),
  );
}

/**
 * The one name rule, shared by `proposeCast` and every writer: a name means a
 * `characters` row when, slugified, it is the row's id, display name or an
 * alias. Ids win over display names, display names over aliases (the rule in
 * the review editor's loader).
 */
function nameResolver(
  characters: CharacterRow[],
): (name: string) => CharacterRow | undefined {
  const rowByKey = new Map<string, CharacterRow>();
  const index = (key: string, row: CharacterRow) => {
    if (key && !rowByKey.has(key)) rowByKey.set(key, row);
  };
  for (const row of characters) index(row.id, row);
  for (const row of characters) index(slugify(row.display_name ?? ""), row);
  for (const row of characters)
    for (const alias of row.aliases) index(slugify(alias), row);
  return (name) => rowByKey.get(slugify(name));
}

/** The book's castlist, issue order, `voice_of` links and name resolver, for `voiceFor` and the writers. */
export async function loadBookCast(
  client: Client,
  bookId: string,
): Promise<BookCast> {
  const [rows, issues, characters] = await Promise.all([
    readAll<CastRow>("the castlist", (from, to) =>
      db(client)
        .from("castlist")
        .select(
          "issue_id, character, character_id, voice_id, voice_uuid, in_issue",
        )
        .eq("book_id", bookId)
        .order("issue_id")
        .order("character")
        .range(from, to),
    ),
    listBookIssues(client, bookId, "id, number"),
    readCharacters(client),
  ]);
  must("reading the book's issues", issues.error);
  return {
    bookId,
    rows,
    issueNumber: new Map(
      (issues.data ?? []).map((i) => [i.id, i.number ?? 0] as const),
    ),
    voiceOf: new Map(characters.map((c) => [c.id, c.voice_of])),
    resolve: nameResolver(characters),
  };
}

/** One issue's rows for a character: by `character_id`, else the null-id rows whose text resolves to it (`rowCharacterId`). */
function matchRows(
  book: BookCast,
  issueRows: CastRow[],
  characterId: string,
): CastRow[] {
  const byId = issueRows.filter((r) => r.character_id === characterId);
  if (byId.length > 0) return byId;
  return issueRows.filter(
    (r) => r.character_id === null && rowCharacterId(book, r) === characterId,
  );
}

/** The character's rows in every issue of the book, matched per issue as `matchRows` does. */
function matchBookRows(book: BookCast, characterId: string): CastRow[] {
  const byIssue = new Map<string, CastRow[]>();
  for (const r of book.rows)
    byIssue.set(r.issue_id, [...(byIssue.get(r.issue_id) ?? []), r]);
  return [...byIssue.values()].flatMap((rows) =>
    matchRows(book, rows, characterId),
  );
}

/** The character a castlist row belongs to: its `character_id`, else what its text resolves to, else its slug. */
function rowCharacterId(book: BookCast, row: CastRow): string {
  return (
    row.character_id ??
    book.resolve(row.character)?.id ??
    slugify(row.character)
  );
}

/** The skip sentinel marks deliberate silence; it is not a voice. */
const isSkipped = (r: CastRow) => r.voice_id === SKIPPED_VOICE;
const hasVoice = (r: CastRow) =>
  !isSkipped(r) && (r.voice_uuid !== null || r.voice_id !== null);

/** The character's own castlist voice: this issue's row first, then the latest issue's. */
function ownVoice(
  book: BookCast,
  characterId: string,
  issueId?: string,
): CastRow | undefined {
  const voiced = matchBookRows(book, characterId).filter(hasVoice);
  const here = voiced.find((r) => r.issue_id === issueId);
  if (here) return here;
  return voiced.sort(
    (a, b) =>
      (book.issueNumber.get(b.issue_id) ?? 0) -
      (book.issueNumber.get(a.issue_id) ?? 0),
  )[0];
}

/**
 * The one voice rule: the character's own castlist voice, else that of the
 * character its `voice_of` names; null when neither has one.
 * A character whose row in `issueId` is skipped (and none of its rows there is voiced) gets null: silent, no own or borrowed voice.
 */
export function voiceFor(
  book: BookCast,
  characterId: string,
  issueId?: string,
): CastVoice | null {
  const own = ownVoice(book, characterId, issueId);
  if (own && own.issue_id === issueId) return toVoice(own, characterId);
  const here = book.rows.filter((r) => r.issue_id === issueId);
  if (matchRows(book, here, characterId).some(isSkipped)) return null;
  if (own) return toVoice(own, characterId);
  const other = book.voiceOf.get(characterId);
  if (!other || other === characterId) return null;
  const borrowed = ownVoice(book, other, issueId);
  return borrowed ? toVoice(borrowed, other) : null;
}

function toVoice(row: CastRow, from: string): CastVoice {
  return { voiceUuid: row.voice_uuid, voiceId: row.voice_id, from };
}

/** `issues.wiki_appearances` as name and qualifier pairs, whatever the JSON holds. */
function wikiNames(value: unknown): { name: string; qualifier: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object") return [];
    const { name, qualifier } = entry as {
      name?: unknown;
      qualifier?: unknown;
    };
    if (typeof name !== "string" || !name.trim()) return [];
    return [
      {
        name: name.trim(),
        qualifier: typeof qualifier === "string" ? qualifier.trim() : "",
      },
    ];
  });
}

/** Read-only. The row-237 union for one issue (faces, the book's castlist, the wiki names, the three roles), each member with its sources; names no `characters` row knows come back as suggestions. */
export async function proposeCast(
  client: Client,
  bookId: string,
  issueId: string,
): Promise<CastProposal> {
  return proposeFrom(client, await loadBookCast(client, bookId), issueId);
}

async function proposeFrom(
  client: Client,
  book: BookCast,
  issueId: string,
): Promise<CastProposal> {
  const { bookId, resolve } = book;
  const [issue, faceRows] = await Promise.all([
    selectIssue(client, bookId, issueId, "wiki_appearances").maybeSingle(),
    readAll<{ character_id: string | null }>("face detections", (from, to) =>
      db(client)
        .from("panel_character_detections")
        .select("character_id, panels!inner(book_id, issue_id)")
        .eq("panels.book_id", bookId)
        .eq("panels.issue_id", issueId)
        .not("character_id", "is", null)
        .order("id")
        .range(from, to),
    ),
  ]);
  must("reading the issue", issue.error);
  if (!issue.data) throw new Error(`cast: no issue ${bookId}/${issueId}`);

  const members = new Map<string, ProposedMember>();
  const member = (row: CharacterRow, source: CastSource): ProposedMember => {
    let m = members.get(row.id);
    if (!m) {
      m = {
        id: row.id,
        name: row.display_name ?? row.id,
        sources: [],
        faces: 0,
        wikiNames: [],
        castNames: [],
      };
      members.set(row.id, m);
    }
    if (!m.sources.includes(source)) m.sources.push(source);
    return m;
  };
  const suggestions: CastSuggestion[] = [];
  const suggest = (s: CastSuggestion) => {
    if (!suggestions.some((x) => slugify(x.name) === slugify(s.name)))
      suggestions.push(s);
  };

  for (const id of ROLE_IDS) {
    const row = resolve(id);
    member(
      row ?? { id, display_name: id, aliases: [], voice_of: null },
      "role",
    );
  }
  for (const f of faceRows) {
    const row = f.character_id ? resolve(f.character_id) : undefined;
    if (row) member(row, "faces").faces++;
  }
  for (const c of book.rows) {
    const row = resolve(c.character_id ?? c.character);
    if (row) {
      const m = member(row, "cast before");
      if (!m.castNames.includes(c.character)) m.castNames.push(c.character);
    } else suggest({ name: c.character, qualifier: "", source: "cast before" });
  }
  for (const { name, qualifier } of wikiNames(issue.data.wiki_appearances)) {
    // "Kimberly Hart (Pink Ranger)": a name no row knows joins the row its
    // qualifier names, and does not become a second member.
    const row = resolve(name) ?? (qualifier ? resolve(qualifier) : undefined);
    const label = qualifier ? `${name} (${qualifier})` : name;
    if (row) member(row, "wiki").wikiNames.push(label);
    else suggest({ name, qualifier, source: "wiki" });
  }

  const sorted = [...members.values()].sort((a, b) => {
    const ra = isRoleId(a.id);
    const rb = isRoleId(b.id);
    return ra === rb ? a.name.localeCompare(b.name) : ra ? 1 : -1;
  });
  return { members: sorted, suggestions };
}

/** The voice a new castlist row starts with: the character's latest castlist voice in the book, else its active `voices` row. */
async function startingVoice(
  client: Client,
  book: BookCast,
  characterId: string,
): Promise<{ voice_id: string | null; voice_uuid: string | null }> {
  const latest = ownVoice(book, characterId);
  if (latest)
    return { voice_id: latest.voice_id, voice_uuid: latest.voice_uuid };
  const { data, error } = await db(client)
    .from("voices")
    .select("id, current_elevenlabs_id")
    .eq("character_id", characterId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1);
  must(`reading the voice of ${characterId}`, error);
  const v = data?.[0];
  return {
    voice_id: v?.current_elevenlabs_id ?? null,
    voice_uuid: v?.id ?? null,
  };
}

async function linkRow(
  client: Client,
  bookId: string,
  row: CastRow,
  patch: Database["public"]["Tables"]["castlist"]["Update"],
): Promise<void> {
  const { error } = await db(client)
    .from("castlist")
    .update(patch)
    .eq("book_id", bookId)
    .eq("issue_id", row.issue_id)
    .eq("character", row.character);
  must(`updating castlist ${row.issue_id}/${row.character}`, error);
}

async function insertRow(
  client: Client,
  book: BookCast,
  issueId: string,
  characterId: string,
  name: string,
): Promise<void> {
  const voice = await startingVoice(client, book, characterId);
  const { error } = await db(client)
    .from("castlist")
    .insert({
      book_id: book.bookId,
      issue_id: issueId,
      character: name,
      character_id: characterId,
      in_issue: true,
      ...voice,
    });
  must(`inserting castlist ${issueId}/${name}`, error);
}

export interface SeedResult {
  /** Rows found by name (id, display name or alias) that now carry `character_id`. */
  linked: string[];
  inserted: string[];
  /** Members whose row already had `character_id`, removed ones included. */
  kept: string[];
}

/** Writes `proposeCast`'s members into the issue's castlist: links a row found by name (as `proposeCast` resolves it), inserts one only when none matches; never creates a character, never sets `in_issue` back to true. */
export async function seedCast(
  client: Client,
  bookId: string,
  issueId: string,
): Promise<SeedResult> {
  const book = await loadBookCast(client, bookId);
  const proposal = await proposeFrom(client, book, issueId);
  const issueRows = book.rows.filter((r) => r.issue_id === issueId);
  const result: SeedResult = { linked: [], inserted: [], kept: [] };
  for (const m of proposal.members) {
    const found = matchRows(book, issueRows, m.id);
    if (found.length === 0) {
      await insertRow(client, book, issueId, m.id, m.name);
      result.inserted.push(m.id);
      continue;
    }
    for (const row of found) {
      if (row.character_id === m.id) continue;
      await linkRow(client, bookId, row, { character_id: m.id });
    }
    (found.some((r) => r.character_id === null)
      ? result.linked
      : result.kept
    ).push(m.id);
  }
  return result;
}

export interface CastEntry {
  character: string;
  characterId: string | null;
  voice: CastVoice | null;
}

/** The issue's cast: its castlist rows with `in_issue` true, each with its voice from `voiceFor`. */
export async function getCast(
  client: Client,
  bookId: string,
  issueId: string,
): Promise<CastEntry[]> {
  const book = await loadBookCast(client, bookId);
  return book.rows
    .filter((r) => r.issue_id === issueId && r.in_issue)
    .map((r) => ({
      character: r.character,
      characterId: r.character_id,
      voice: voiceFor(book, rowCharacterId(book, r), issueId),
    }));
}

/** Puts a character in the issue's cast: sets `in_issue` and `character_id` on its row, or inserts one with its starting voice. */
export async function addToCast(
  client: Client,
  bookId: string,
  issueId: string,
  characterId: string,
): Promise<void> {
  const book = await loadBookCast(client, bookId);
  const found = matchRows(
    book,
    book.rows.filter((r) => r.issue_id === issueId),
    characterId,
  );
  if (found.length > 0) {
    for (const row of found)
      await linkRow(client, bookId, row, {
        character_id: characterId,
        in_issue: true,
      });
    return;
  }
  const character = book.resolve(characterId);
  if (character?.id !== characterId)
    throw new Error(`cast: no character ${characterId}`);
  await insertRow(
    client,
    book,
    issueId,
    characterId,
    character.display_name ?? characterId,
  );
}

/** Takes a character out of the issue's cast: `in_issue` false on its rows, which are never deleted, so the voice is kept. Returns the rows changed. */
export async function removeFromCast(
  client: Client,
  bookId: string,
  issueId: string,
  characterId: string,
): Promise<number> {
  const book = await loadBookCast(client, bookId);
  const found = matchRows(
    book,
    book.rows.filter((r) => r.issue_id === issueId),
    characterId,
  );
  for (const row of found)
    await linkRow(client, bookId, row, {
      character_id: characterId,
      in_issue: false,
    });
  return found.length;
}

/** Sets the character's voice on its castlist rows in every issue of the book (decisions row 28), matched as `seedCast` matches; inserts none. Returns the rows written. */
export async function setVoice(
  client: Client,
  bookId: string,
  characterId: string,
  voiceUuid: string,
): Promise<number> {
  const [book, voice] = await Promise.all([
    loadBookCast(client, bookId),
    db(client)
      .from("voices")
      .select("id, current_elevenlabs_id")
      .eq("id", voiceUuid)
      .maybeSingle(),
  ]);
  must(`reading voice ${voiceUuid}`, voice.error);
  if (!voice.data) throw new Error(`cast: no voice ${voiceUuid}`);
  const rows = matchBookRows(book, characterId);
  for (const row of rows)
    await linkRow(client, bookId, row, {
      character_id: characterId,
      voice_uuid: voice.data.id,
      voice_id: voice.data.current_elevenlabs_id,
    });
  return rows.length;
}

/** Creates a `characters` row; the id must already be in slug form (`slugify`). */
export async function createCharacter(
  client: Client,
  character: { id: string; displayName: string; franchise: string | null },
): Promise<void> {
  if (!character.id || slugify(character.id) !== character.id)
    throw new Error(`cast: "${character.id}" is not a slug id`);
  const { error } = await db(client).from("characters").insert({
    id: character.id,
    display_name: character.displayName,
    franchise: character.franchise,
  });
  must(`creating character ${character.id}`, error);
}

/** Changes a character's display name only; its id and the castlist texts stay as they are. */
export async function renameCharacter(
  client: Client,
  characterId: string,
  displayName: string,
): Promise<void> {
  const { data, error } = await db(client)
    .from("characters")
    .update({ display_name: displayName })
    .eq("id", characterId)
    .select("id");
  must(`renaming character ${characterId}`, error);
  if (!data?.length) throw new Error(`cast: no character ${characterId}`);
}

/** Records the voice the owner wants for a character in this issue; upserts on (book, issue, character), so a cancelled or carried-out request can be made again. */
export async function storeVoiceRequest(
  client: Client,
  bookId: string,
  issueId: string,
  characterId: string,
  request: VoiceRequest,
): Promise<void> {
  const { error } = await db(client)
    .from("casting_tasks")
    .upsert(
      {
        book_id: bookId,
        issue_id: issueId,
        character_id: characterId,
        action: request.action,
        target_voice_uuid:
          request.action === "clone" ? request.targetVoiceUuid : null,
        status: "pending",
        completed_at: null,
      },
      { onConflict: "book_id,issue_id,character_id" },
    );
  must(`storing the voice request for ${characterId}`, error);
}

/** The issue's voice requests: its `casting_tasks` rows that carry an `action`. */
export async function readVoiceRequests(
  client: Client,
  bookId: string,
  issueId: string,
): Promise<StoredVoiceRequest[]> {
  const { data, error } = await db(client)
    .from("casting_tasks")
    .select("character_id, action, target_voice_uuid, status, completed_at")
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .not("action", "is", null)
    .order("character_id");
  must("reading voice requests", error);
  return (data ?? []).map((t) => ({
    characterId: t.character_id,
    action: t.action as "clone" | "design",
    targetVoiceUuid: t.target_voice_uuid,
    status: t.status,
    completedAt: t.completed_at,
  }));
}

/** Cancels a voice request by deleting its row; a casting task with no `action` is not a request and stays. */
export async function cancelVoiceRequest(
  client: Client,
  bookId: string,
  issueId: string,
  characterId: string,
): Promise<void> {
  const { error } = await db(client)
    .from("casting_tasks")
    .delete()
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("character_id", characterId)
    .not("action", "is", null);
  must(`cancelling the voice request for ${characterId}`, error);
}

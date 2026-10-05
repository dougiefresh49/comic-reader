/**
 * The one home for an issue's cast (#347) and the one home of every
 * `castlist` read and write (#429): the three role ids, the proposed cast
 * (decisions rows 237 and 242), seeding it into `castlist`, the render chain
 * (which voice a character speaks with), add, remove, set a voice, "no
 * audio", creating and renaming characters, and voice requests
 * (`casting_tasks` rows with an `action`).
 *
 * Every function takes the Supabase client, like `issue-queries.ts`: server
 * code passes `supabaseAdmin`, a workflow step its step client, a script its
 * own. Every `castlist` and `casting_tasks` query filters by book, and by issue
 * when it is about one issue. Every `castlist` row is found by
 * `character_id`; the text `character` is only shown, and an insert fills it
 * with the character id until P6 drops it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "~/types/database";
import { slugify } from "~/lib/character-id";
import { listBookIssues, selectIssue } from "~/lib/issue-queries";

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

/** A character's voice as the render chain finds it. */
export interface CastVoice {
  /** The `voices` row. */
  voiceUuid: string;
  /** Its `current_elevenlabs_id` while the voice is active; null when it is not in a slot. */
  elevenLabsId: string | null;
  /** The character whose castlist row holds it: the character itself, or its `form_of`. */
  from: string;
}

export interface CastRow {
  issue_id: string;
  /** Shown only, never matched on; P6 drops it. */
  character: string;
  character_id: string | null;
  voice_uuid: string | null;
  in_issue: boolean;
  no_audio: boolean;
}

/** The `voices` fields the render chain reads. */
export interface CastVoiceRow {
  id: string;
  current_elevenlabs_id: string | null;
  status: string;
}

export interface CharacterRow {
  id: string;
  display_name: string | null;
  aliases: string[];
  form_of: string | null;
}

/** What the render chain and the writers read: the book's castlist, its issue order, the `voices` rows it points at, `characters.form_of`, and the name resolver. */
export interface BookCast {
  bookId: string;
  rows: CastRow[];
  issueNumber: Map<string, number>;
  /** Every `voices` row a castlist row of the book points at, by id. */
  voices: Map<string, CastVoiceRow>;
  formOf: Map<string, string | null>;
  /** The `characters` row a name means: its id, display name or an alias, compared slugified. For wiki names and new aliases; never for a castlist row. */
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
      .select("id, display_name, aliases, form_of")
      .order("id")
      .range(from, to),
  );
}

/**
 * The one name rule for wiki names and new aliases: a name means a
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

const CAST_COLUMNS =
  "issue_id, character, character_id, voice_uuid, in_issue, no_audio";

/** The `voices` rows these ids name, in chunks that keep the URL short. */
async function readCastVoices(
  client: Client,
  ids: Iterable<string>,
): Promise<Map<string, CastVoiceRow>> {
  const list = [...new Set(ids)];
  const out = new Map<string, CastVoiceRow>();
  for (let i = 0; i < list.length; i += 200) {
    const { data, error } = await db(client)
      .from("voices")
      .select("id, current_elevenlabs_id, status")
      .in("id", list.slice(i, i + 200));
    must("reading the cast's voices", error);
    for (const v of data ?? []) out.set(v.id, v);
  }
  return out;
}

/** The book's castlist, issue order, the voices it points at, `form_of` links and name resolver, for the render chain and the writers. */
export async function loadBookCast(
  client: Client,
  bookId: string,
): Promise<BookCast> {
  const [rows, issues, characters] = await Promise.all([
    readAll<CastRow>("the castlist", (from, to) =>
      db(client)
        .from("castlist")
        .select(CAST_COLUMNS)
        .eq("book_id", bookId)
        .order("issue_id")
        .order("character")
        .range(from, to),
    ),
    listBookIssues(client, bookId, "id, number"),
    readCharacters(client),
  ]);
  must("reading the book's issues", issues.error);
  const voices = await readCastVoices(
    client,
    rows.flatMap((r) => (r.voice_uuid ? [r.voice_uuid] : [])),
  );
  return {
    bookId,
    rows,
    issueNumber: new Map(
      (issues.data ?? []).map((i) => [i.id, i.number ?? 0] as const),
    ),
    voices,
    formOf: new Map(characters.map((c) => [c.id, c.form_of])),
    resolve: nameResolver(characters),
  };
}

/** One home for the issue's cast (#409): its castlist rows with `in_issue` true. */
export function issueCast(book: BookCast, issueId: string): CastRow[] {
  return book.rows.filter((r) => r.issue_id === issueId && r.in_issue);
}

/** The issue's castlist row for a character, found by `character_id`. */
export function castRow(
  book: BookCast,
  characterId: string,
  issueId: string,
): CastRow | undefined {
  return book.rows.find(
    (r) => r.issue_id === issueId && r.character_id === characterId,
  );
}

/** The latest issue's row in the book that holds a voice for the character. A "no audio" row silences its own issue only and still lends its voice here. */
function latestVoicedRow(
  book: BookCast,
  characterId: string,
): CastRow | undefined {
  return book.rows
    .filter((r) => r.character_id === characterId && r.voice_uuid)
    .sort(
      (a, b) =>
        (book.issueNumber.get(b.issue_id) ?? 0) -
        (book.issueNumber.get(a.issue_id) ?? 0),
    )[0];
}

/** Why the render chain gives a character no audio. */
export type NoVoiceReason =
  /** `bubbles.character_id` is null: the bubble is unassigned. */
  | "unassigned"
  /** The issue's row has `in_issue` false: speaker removed from this issue. */
  | "removed"
  /** The issue's row has `no_audio` true: silent by choice. */
  | "no audio"
  /** No row in the book holds a voice, the character's or its `form_of`'s. */
  | "no voice"
  /** Cast, and the voice is not in a slot. */
  | "not in a slot";

export type RenderVoice =
  | {
      ok: true;
      characterId: string;
      /** The character whose castlist row holds the voice: itself, or its `form_of`. */
      from: string;
      voiceUuid: string;
      elevenLabsId: string;
    }
  | {
      ok: false;
      reason: NoVoiceReason;
      characterId: string | null;
      /** Set when a voice was found ("not in a slot"). */
      voice: CastVoice | null;
      /** One line naming the case, for logs and error messages. */
      detail: string;
    };

/** Steps 2 to 4 of the chain for one character: a stop, the row that holds its voice, or none. */
function chainStep(
  book: BookCast,
  characterId: string,
  issueId: string | undefined,
): { stop: "removed" | "no audio" } | { row: CastRow } | null {
  const here = issueId ? castRow(book, characterId, issueId) : undefined;
  if (here && !here.in_issue) return { stop: "removed" };
  if (here?.no_audio) return { stop: "no audio" };
  if (here?.voice_uuid) return { row: here };
  const latest = latestVoicedRow(book, characterId);
  return latest ? { row: latest } : null;
}

/**
 * The render chain ("How it works after" in `docs/casting-data-model.html`),
 * the one rule for which voice a character speaks with in an issue:
 *
 * 1. No character (a null `bubbles.character_id`): no audio, unassigned.
 * 2. The issue's row has `in_issue` false: no audio, removed from this issue.
 * 3. The issue's row has `no_audio` true: no audio by choice, nothing borrowed.
 * 4. That row's voice; with no row or no voice there, the latest issue's row
 *    in the book that has one.
 * 5. Still none and the character has `form_of`: steps 2 to 4 for that
 *    character, once.
 * 6. The `voices` row: active renders with `current_elevenlabs_id`; anything
 *    else is "cast, voice not in a slot".
 *
 * With no `issueId`, steps 2 and 3 are skipped and step 4 is the latest row.
 */
export function renderVoice(
  book: BookCast,
  characterId: string | null,
  issueId?: string,
): RenderVoice {
  const no = (
    reason: NoVoiceReason,
    detail: string,
    voice: CastVoice | null = null,
  ): RenderVoice => ({ ok: false, reason, characterId, voice, detail });
  if (!characterId) return no("unassigned", "no character_id");

  let from = characterId;
  let step = chainStep(book, characterId, issueId);
  if (step === null) {
    const other = book.formOf.get(characterId);
    if (other && other !== characterId) {
      from = other;
      step = chainStep(book, other, issueId);
    }
  }
  const via = from === characterId ? "" : ` (form of ${from})`;
  if (step === null)
    return no("no voice", `${characterId} has no voice of its own${via}`);
  if ("stop" in step)
    return step.stop === "removed"
      ? no("removed", `${from} is removed from this issue${via}`)
      : no("no audio", `${from} is marked no audio in this issue${via}`);

  const voiceUuid = step.row.voice_uuid!;
  const row = book.voices.get(voiceUuid);
  const elevenLabsId =
    row?.status === "active" ? (row.current_elevenlabs_id ?? null) : null;
  const voice: CastVoice = { voiceUuid, elevenLabsId, from };
  if (!elevenLabsId)
    return no(
      "not in a slot",
      `${characterId}'s voice ${voiceUuid} is ${row?.status ?? "missing"}, not in a slot${via}`,
      voice,
    );
  return { ok: true, characterId, from, voiceUuid, elevenLabsId };
}

/**
 * The voice the render chain finds for a character, playable or not: null
 * when the chain stops before a voice (removed, no audio, or none at all).
 * `elevenLabsId` is null when the voice is not in a slot.
 */
export function voiceFor(
  book: BookCast,
  characterId: string,
  issueId?: string,
): CastVoice | null {
  const found = renderVoice(book, characterId, issueId);
  if (found.ok)
    return {
      voiceUuid: found.voiceUuid,
      elevenLabsId: found.elevenLabsId,
      from: found.from,
    };
  return found.voice;
}

/** The issue hub's two castlist counts: the issue's rows, and those settled for audio (an active voice, or "no audio"). */
export async function countIssueCast(
  client: Client,
  bookId: string,
  issueId: string,
): Promise<{ rows: number; withVoice: number }> {
  const book = await loadBookCast(client, bookId);
  const rows = book.rows.filter((r) => r.issue_id === issueId);
  return {
    rows: rows.length,
    withVoice: rows.filter(
      (r) =>
        r.no_audio ||
        (r.voice_uuid !== null &&
          book.voices.get(r.voice_uuid)?.status === "active"),
    ).length,
  };
}

/** True when the issue's castlist row for the character has `no_audio`: deliberate silence, not voice work. */
export function isNoAudio(
  book: BookCast,
  characterId: string,
  issueId: string,
): boolean {
  return castRow(book, characterId, issueId)?.no_audio === true;
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
    member(row ?? { id, display_name: id, aliases: [], form_of: null }, "role");
  }
  for (const f of faceRows) {
    const row = f.character_id ? resolve(f.character_id) : undefined;
    if (row) member(row, "faces").faces++;
  }
  for (const c of book.rows) {
    const row = c.character_id ? resolve(c.character_id) : undefined;
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
): Promise<string | null> {
  const latest = latestVoicedRow(book, characterId);
  if (latest) return latest.voice_uuid;
  const { data, error } = await db(client)
    .from("voices")
    .select("id")
    .eq("character_id", characterId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1);
  must(`reading the voice of ${characterId}`, error);
  return data?.[0]?.id ?? null;
}

type CastPatch = Pick<
  Database["public"]["Tables"]["castlist"]["Update"],
  "in_issue" | "no_audio" | "voice_uuid"
>;

/** Updates the issue's row for the character; returns how many rows changed (0 or 1). */
async function updateRow(
  client: Client,
  bookId: string,
  issueId: string,
  characterId: string,
  patch: CastPatch,
): Promise<number> {
  const { data, error } = await db(client)
    .from("castlist")
    .update(patch)
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("character_id", characterId)
    .select("issue_id");
  must(`updating castlist ${issueId}/${characterId}`, error);
  return data?.length ?? 0;
}

/**
 * Inserts the issue's row for the character, `character` filled with the id
 * (P6 drops that column). Upserts on `(book_id, issue_id, character_id)`
 * ignoring a duplicate, so a row another writer added first is kept as it is.
 *
 * A legacy row with a null `character_id` whose text is that id (character
 * "narrator", for example) holds the old primary key on (book_id, issue_id,
 * character), so the insert would fail: that row is adopted instead, in one
 * update that sets its `character_id` and the caller's `patch`, and leaves
 * its other columns as they are.
 */
async function insertRow(
  client: Client,
  bookId: string,
  issueId: string,
  characterId: string,
  row: Required<CastPatch>,
  patch: CastPatch = {},
): Promise<void> {
  const adopted = await db(client)
    .from("castlist")
    .update({ ...patch, character_id: characterId })
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("character", characterId)
    .is("character_id", null)
    .select("issue_id");
  must(`adopting castlist ${issueId}/${characterId}`, adopted.error);
  if (adopted.data?.length) return;
  const { error } = await db(client)
    .from("castlist")
    .upsert(
      {
        book_id: bookId,
        issue_id: issueId,
        character: characterId,
        character_id: characterId,
        ...row,
      },
      { onConflict: "book_id,issue_id,character_id", ignoreDuplicates: true },
    );
  must(`inserting castlist ${issueId}/${characterId}`, error);
}

/** Writes the patch on the issue's row, or inserts the row with the starting voice when there is none. */
async function writeRow(
  client: Client,
  book: BookCast,
  issueId: string,
  characterId: string,
  patch: CastPatch,
): Promise<void> {
  if ((await updateRow(client, book.bookId, issueId, characterId, patch)) > 0)
    return;
  const voice_uuid =
    patch.voice_uuid !== undefined
      ? patch.voice_uuid
      : await startingVoice(client, book, characterId);
  await insertRow(
    client,
    book.bookId,
    issueId,
    characterId,
    {
      in_issue: patch.in_issue ?? true,
      no_audio: patch.no_audio ?? false,
      voice_uuid,
    },
    patch,
  );
  // A row another writer inserted first was kept: write the patch on it.
  await updateRow(client, book.bookId, issueId, characterId, patch);
}

/** Points the issue's row for the character at a voice, inserting the row (`in_issue` true) when there is none; other issues' rows are left alone. */
export async function setIssueVoice(
  client: Client,
  bookId: string,
  issueId: string,
  characterId: string,
  voiceUuid: string,
): Promise<void> {
  const patch = { voice_uuid: voiceUuid };
  if ((await updateRow(client, bookId, issueId, characterId, patch)) > 0)
    return;
  await insertRow(
    client,
    bookId,
    issueId,
    characterId,
    { in_issue: true, no_audio: false, voice_uuid: voiceUuid },
    patch,
  );
  // A row another writer inserted first was kept: write the patch on it.
  await updateRow(client, bookId, issueId, characterId, patch);
}

/** The issue's castlist row for one character, read on its own; null when there is none. */
export async function readCastRow(
  client: Client,
  bookId: string,
  issueId: string,
  characterId: string,
): Promise<CastRow | null> {
  const { data, error } = await db(client)
    .from("castlist")
    .select(CAST_COLUMNS)
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("character_id", characterId)
    .limit(1);
  must(`reading castlist ${issueId}/${characterId}`, error);
  return data?.[0] ?? null;
}

export interface SeedResult {
  inserted: string[];
  /** Members that already had a row, removed ones included. */
  kept: string[];
}

/** Writes `proposeCast`'s members into the issue's castlist: inserts a row only for a member with none; never creates a character, never sets `in_issue` back to true. */
export async function seedCast(
  client: Client,
  bookId: string,
  issueId: string,
): Promise<SeedResult> {
  const book = await loadBookCast(client, bookId);
  const proposal = await proposeFrom(client, book, issueId);
  const result: SeedResult = { inserted: [], kept: [] };
  for (const m of proposal.members) {
    if (castRow(book, m.id, issueId)) {
      result.kept.push(m.id);
      continue;
    }
    await insertRow(client, bookId, issueId, m.id, {
      in_issue: true,
      no_audio: false,
      voice_uuid: await startingVoice(client, book, m.id),
    });
    result.inserted.push(m.id);
  }
  return result;
}

export interface CastEntry {
  character: string;
  characterId: string | null;
  voice: CastVoice | null;
}

/** The issue's cast (`issueCast`), each row with its voice from `voiceFor`. */
export async function getCast(
  client: Client,
  bookId: string,
  issueId: string,
): Promise<CastEntry[]> {
  const book = await loadBookCast(client, bookId);
  return issueCast(book, issueId).map((r) => ({
    character: r.character,
    characterId: r.character_id,
    voice: r.character_id ? voiceFor(book, r.character_id, issueId) : null,
  }));
}

/** Puts a character in the issue's cast: sets `in_issue` on its row, or inserts one with its starting voice. */
export async function addToCast(
  client: Client,
  bookId: string,
  issueId: string,
  characterId: string,
): Promise<void> {
  const book = await loadBookCast(client, bookId);
  if (!castRow(book, characterId, issueId)) {
    const character = book.resolve(characterId);
    if (character?.id !== characterId)
      throw new Error(`cast: no character ${characterId}`);
  }
  await writeRow(client, book, issueId, characterId, { in_issue: true });
}

/** Takes a character out of the issue's cast: `in_issue` false on its row, which is never deleted, so the voice is kept. Returns the rows changed. */
export async function removeFromCast(
  client: Client,
  bookId: string,
  issueId: string,
  characterId: string,
): Promise<number> {
  return updateRow(client, bookId, issueId, characterId, { in_issue: false });
}

/**
 * Sets or clears "no audio" on the issue's row for the character (#429). The
 * voice reference is left alone. Setting it inserts the row (with its
 * starting voice) when the issue has none; clearing it inserts nothing.
 * Returns the rows changed.
 */
export async function setNoAudio(
  client: Client,
  bookId: string,
  issueId: string,
  characterId: string,
  noAudio: boolean,
): Promise<number> {
  if (!noAudio)
    return updateRow(client, bookId, issueId, characterId, {
      no_audio: false,
    });
  const book = await loadBookCast(client, bookId);
  if (!castRow(book, characterId, issueId)) {
    const character = book.resolve(characterId);
    if (character?.id !== characterId)
      throw new Error(`cast: no character ${characterId}`);
  }
  await writeRow(client, book, issueId, characterId, { no_audio: true });
  return 1;
}

/** Sets the character's voice on its castlist rows in every issue of the book (decisions row 28); inserts none. Returns the rows written. */
export async function setVoice(
  client: Client,
  bookId: string,
  characterId: string,
  voiceUuid: string,
): Promise<number> {
  const voice = await db(client)
    .from("voices")
    .select("id")
    .eq("id", voiceUuid)
    .maybeSingle();
  must(`reading voice ${voiceUuid}`, voice.error);
  if (!voice.data) throw new Error(`cast: no voice ${voiceUuid}`);
  const { data, error } = await db(client)
    .from("castlist")
    .update({ voice_uuid: voice.data.id })
    .eq("book_id", bookId)
    .eq("character_id", characterId)
    .select("issue_id");
  must(`setting the voice of ${characterId}`, error);
  return data?.length ?? 0;
}

/**
 * Casts a voice for a character in one issue and the rest of the book: the
 * issue's row is inserted when it has none (with `in_issue` true), then every
 * row of the character in the book points at the voice. Returns the rows
 * written.
 */
export async function castVoiceInBook(
  client: Client,
  bookId: string,
  issueId: string,
  characterId: string,
  voiceUuid: string,
): Promise<number> {
  await setIssueVoice(client, bookId, issueId, characterId, voiceUuid);
  return setVoice(client, bookId, characterId, voiceUuid);
}

/** A castlist row anywhere in the database, for the slot planner: which books and issues hold each voice. */
export interface CastVoiceLink {
  book_id: string;
  issue_id: string;
  character: string;
  character_id: string | null;
  voice_uuid: string | null;
}

/** Every castlist row with its voice reference, in one book or every book. */
export async function readCastVoiceLinks(
  client: Client,
  bookId?: string,
): Promise<CastVoiceLink[]> {
  return readAll<CastVoiceLink>("the castlist", (from, to) => {
    let q = db(client)
      .from("castlist")
      .select("book_id, issue_id, character, character_id, voice_uuid");
    if (bookId) q = q.eq("book_id", bookId);
    return q
      .order("book_id")
      .order("issue_id")
      .order("character")
      .range(from, to);
  });
}

/** Deletes every castlist row of a book; for a scratch book's cleanup (`scripts/smoke-ingest.ts`), never a real one. */
export async function deleteBookCast(
  client: Client,
  bookId: string,
): Promise<void> {
  const { error } = await db(client)
    .from("castlist")
    .delete()
    .eq("book_id", bookId);
  must(`deleting the castlist of ${bookId}`, error);
}

/** The issue's cast (`issueCast`, so removed rows stay out) as its castlist `character` texts, sorted, as shown to the reader and to Gemini; empty when the issue has none. */
export async function readCastNames(
  client: Client,
  bookId: string,
  issueId: string,
): Promise<string[]> {
  const book = await loadBookCast(client, bookId);
  return issueCast(book, issueId)
    .map((r) => r.character)
    .sort();
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

/** Makes a name resolve to a character by appending it to `aliases`; false when it already did, a throw when it means another character. */
export async function addAlias(
  client: Client,
  characterId: string,
  alias: string,
): Promise<boolean> {
  const name = alias.trim();
  if (!slugify(name)) throw new Error(`cast: "${name}" is not a name`);
  const characters = await readCharacters(client);
  const means = nameResolver(characters)(name);
  if (means?.id === characterId) return false;
  if (means) throw new Error(`cast: "${name}" already means ${means.id}`);
  const row = characters.find((c) => c.id === characterId);
  if (!row) throw new Error(`cast: no character ${characterId}`);
  const { data, error } = await db(client)
    .from("characters")
    .update({ aliases: [...row.aliases, name] })
    .eq("id", characterId)
    .select("id");
  must(`adding an alias to ${characterId}`, error);
  if (!data?.length) throw new Error(`cast: no character ${characterId}`);
  return true;
}

/** Records the voice the owner wants for a character in this issue; upserts on (book, issue, character), so a cancelled or carried-out request can be made again. */
export async function storeVoiceRequest(
  client: Client,
  bookId: string,
  issueId: string,
  characterId: string,
  request: VoiceRequest,
): Promise<void> {
  // `operation` (#351) is not in database.ts yet: read it untyped.
  const open = await client
    .from("casting_tasks")
    .select("operation")
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("character_id", characterId);
  must(`reading the voice request for ${characterId}`, open.error);
  if (((open.data ?? []) as { operation: unknown }[]).some((r) => r.operation))
    throw new Error(`cast: a voice operation is open for ${characterId}`);
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
  const { data, error } = await client
    .from("casting_tasks")
    .delete()
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("character_id", characterId)
    .not("action", "is", null)
    .is("operation", null)
    .select("character_id");
  must(`cancelling the voice request for ${characterId}`, error);
  if ((data ?? []).length > 0) return;
  const left = (await readVoiceRequests(client, bookId, issueId)).some(
    (r) => r.characterId === characterId,
  );
  if (left)
    throw new Error(`cast: a voice operation is open for ${characterId}`);
}

/**
 * The one home of every `aliases` read and write (#463, rule R6 in
 * docs/casting-data-model.html): the other text labels a `characters` row
 * goes by, keyed on `character_id`, and the name rule that turns outside text
 * into a character id. `characters.aliases` and `aliases.canonical` are not
 * read or written; P6 drops them.
 *
 * Every function takes the Supabase client, like `~/lib/cast`: server code
 * passes `supabaseAdmin`, a workflow step its step client, a script its own.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "~/types/database";
import { slugify } from "~/lib/character-id";

type Client = SupabaseClient;
const db = (client: Client) => client as SupabaseClient<Database>;

const PAGE = 1000;
/** Ids per `.in()` read, to keep the URL short. */
const IDS_PER_READ = 100;

function must(what: string, error: { message: string } | null): void {
  if (error) throw new Error(`aliases: ${what}: ${error.message}`);
}

/** One `aliases` row of a character: `book` is a row scoped to the book it was read with. */
export interface AliasEntry {
  id: number;
  alias: string;
  scope: "global" | "book";
}

/**
 * The alias rows of each character in `characterIds`, keyed by
 * `character_id`, each list in the order the rows were written. Global rows
 * always; with `bookId`, that book's rows too. A character with none is left
 * out of the map. Throws on a failed read.
 */
export async function readAliasEntries(
  client: Client,
  characterIds: Iterable<string>,
  bookId?: string,
): Promise<Map<string, AliasEntry[]>> {
  const ids = [...new Set(characterIds)];
  // Two reads with `.eq()` filters rather than one `.or()` string, so the
  // book id is never spliced into PostgREST filter syntax.
  const rows: AliasRow[] = [];
  for (let i = 0; i < ids.length; i += IDS_PER_READ) {
    const chunk = ids.slice(i, i + IDS_PER_READ);
    rows.push(
      ...(await readAliasRows(client, chunk, "global", null)),
      ...(bookId ? await readAliasRows(client, chunk, "book", bookId) : []),
    );
  }
  rows.sort((a, b) => a.id - b.id);
  const out = new Map<string, AliasEntry[]>();
  for (const row of rows) {
    if (!row.character_id) continue;
    const list = out.get(row.character_id) ?? [];
    list.push({ id: row.id, alias: row.alias, scope: row.scope });
    out.set(row.character_id, list);
  }
  return out;
}

/**
 * The aliases of each character in `characterIds`, keyed by `character_id`:
 * `readAliasEntries` as text only. Global rows always; with `bookId`, that
 * book's rows too. Throws on a failed read.
 */
export async function readAliases(
  client: Client,
  characterIds: Iterable<string>,
  bookId?: string,
): Promise<Map<string, string[]>> {
  const entries = await readAliasEntries(client, characterIds, bookId);
  return new Map(
    [...entries].map(([id, list]) => [id, list.map((e) => e.alias)]),
  );
}

interface AliasRow {
  id: number;
  alias: string;
  character_id: string | null;
  scope: "global" | "book";
}

/** One scope's alias rows for a set of character ids, paged past the row cap. */
async function readAliasRows(
  client: Client,
  characterIds: string[],
  scope: "global" | "book",
  bookId: string | null,
): Promise<AliasRow[]> {
  const out: AliasRow[] = [];
  for (;;) {
    let query = db(client)
      .from("aliases")
      .select("id, alias, character_id")
      .in("character_id", characterIds)
      .eq("scope", scope);
    if (bookId) query = query.eq("scope_id", bookId);
    const { data, error } = await query
      .order("id")
      .range(out.length, out.length + PAGE - 1);
    must("reading aliases", error);
    const page = data ?? [];
    out.push(...page.map((row) => ({ ...row, scope })));
    if (page.length < PAGE) return out;
  }
}

/** A `characters` row as the name rule reads it. */
export interface NamedCharacter {
  id: string;
  display_name: string | null;
  /** `characters.full_name` ("Tangle the Lemur"); set by `readNamedCharacters`. */
  full_name?: string | null;
  aliases: string[];
}

/**
 * A name's words in sorted order, slugified: "Dimension X Green Ranger" and
 * "Green Dimension X Ranger" both give "dimension-green-ranger-x". Two names
 * with equal keys are the same words in another order.
 */
export function nameWords(text: string): string {
  return slugify(text).split("-").filter(Boolean).sort().join("-");
}

/**
 * The one name rule for outside text (wiki names, new aliases): a name means
 * a `characters` row when, slugified, it is the row's id, display name or an
 * alias. Ids win over display names, display names over aliases. When none
 * of those match, the same words in another order (`nameWords`) mean that
 * row, unless they mean two rows.
 */
export function nameResolver<T extends NamedCharacter>(
  characters: T[],
): (name: string) => T | undefined {
  const rowByKey = new Map<string, T>();
  // null marks a word key two rows give: the fallback picks neither.
  const rowByWords = new Map<string, T | null>();
  const index = (key: string, row: T) => {
    if (!key) return;
    if (!rowByKey.has(key)) rowByKey.set(key, row);
    const words = nameWords(key);
    const had = rowByWords.get(words);
    rowByWords.set(words, had === undefined || had === row ? row : null);
  };
  for (const row of characters) index(row.id, row);
  for (const row of characters) index(slugify(row.display_name ?? ""), row);
  for (const row of characters)
    for (const alias of row.aliases) index(slugify(alias), row);
  return (name) =>
    rowByKey.get(slugify(name)) ?? rowByWords.get(nameWords(name)) ?? undefined;
}

/** Every `characters` row with its global aliases (and with `bookId`, that book's too), for the name rule. */
export async function readNamedCharacters(
  client: Client,
  bookId?: string,
): Promise<NamedCharacter[]> {
  const rows: {
    id: string;
    display_name: string | null;
    full_name: string | null;
  }[] = [];
  for (;;) {
    const { data, error } = await db(client)
      .from("characters")
      .select("id, display_name, full_name")
      .order("id")
      .range(rows.length, rows.length + PAGE - 1);
    must("reading characters", error);
    if (!data?.length) break;
    rows.push(...data);
  }
  const aliases = await readAliases(
    client,
    rows.map((r) => r.id),
    bookId,
  );
  return rows.map((r) => ({ ...r, aliases: aliases.get(r.id) ?? [] }));
}

/** The name rule over every `characters` row and its global aliases. */
export async function loadNameResolver(
  client: Client,
): Promise<(name: string) => NamedCharacter | undefined> {
  return nameResolver(await readNamedCharacters(client));
}

/** `addAlias`'s refusal when the name already means another character, `by`. */
export class AliasTakenError extends Error {
  readonly by: NamedCharacter;
  constructor(name: string, by: NamedCharacter) {
    super(`aliases: "${name}" already means ${by.id}`);
    this.by = by;
  }
}

/**
 * Makes a name resolve to a character by writing one `aliases` row,
 * `canonical` left null, scope global unless `bookId` is given. False when
 * the name already means that character, an `AliasTakenError` when it means
 * another. The name check reads global aliases, plus `checkBookId`'s when
 * given (a global alias added from that book's screen). A row the table
 * already holds under (alias_norm, scope, scope_id) is left as it is.
 */
export async function addAlias(
  client: Client,
  characterId: string,
  alias: string,
  bookId?: string,
  checkBookId?: string,
): Promise<boolean> {
  const name = alias.trim();
  if (!slugify(name)) throw new Error(`aliases: "${name}" is not a name`);
  const characters = await readNamedCharacters(client, checkBookId);
  const means = nameResolver(characters)(name);
  if (means?.id === characterId) return false;
  if (means) throw new AliasTakenError(name, means);
  if (!characters.some((c) => c.id === characterId))
    throw new Error(`aliases: no character ${characterId}`);
  await writeAlias(client, characterId, name, bookId);
  return true;
}

/**
 * Writes one alias row for a character with no name check, `canonical` left
 * null; for a script copying aliases it already trusts. A row the table
 * already holds under (alias_norm, scope, scope_id) is left as it is.
 */
export async function writeAlias(
  client: Client,
  characterId: string,
  alias: string,
  bookId?: string,
): Promise<void> {
  const { error } = await db(client)
    .from("aliases")
    .upsert(
      {
        alias,
        character_id: characterId,
        scope: bookId ? "book" : "global",
        scope_id: bookId ?? null,
      },
      { onConflict: "alias_norm,scope,scope_id", ignoreDuplicates: true },
    );
  must(`writing the alias "${alias}" for ${characterId}`, error);
}

/**
 * Deletes the alias row `aliasId` when it belongs to `characterId`, and
 * returns its text. Throws when no such row was deleted.
 */
export async function removeAlias(
  client: Client,
  aliasId: number,
  characterId: string,
): Promise<string> {
  const { data, error } = await db(client)
    .from("aliases")
    .delete()
    .eq("id", aliasId)
    .eq("character_id", characterId)
    .select("alias");
  must(`deleting alias ${aliasId} of ${characterId}`, error);
  const row = data?.[0];
  if (!row) throw new Error(`aliases: ${characterId} has no alias ${aliasId}`);
  return row.alias;
}

/** Deletes every alias scoped to a book; for a scratch book's cleanup (`scripts/smoke-ingest.ts`), never a real one. */
export async function deleteBookAliases(
  client: Client,
  bookId: string,
): Promise<void> {
  const { error } = await db(client)
    .from("aliases")
    .delete()
    .eq("scope", "book")
    .eq("scope_id", bookId);
  must(`deleting the aliases of ${bookId}`, error);
}

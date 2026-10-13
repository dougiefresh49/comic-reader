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
 * book's rows too. The text drops the scope, so a name rule built on it
 * cannot rank a book alias over a global one: build that from
 * `readNamedCharacters` (`nameResolver` has the rule). Throws on a failed
 * read.
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
  /** Every alias the row was read with: global ones, and a book's when read for one. */
  aliases: string[];
  /**
   * The ones of `aliases` scoped to the book the row was read for, which
   * `nameResolver` ranks above the global ones. Left out, every alias ranks
   * the same, in list order.
   */
  bookAliases?: string[];
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
 * A name lookup over slug keys given in rank order: a name whose slug is a
 * key means the row of the first such key; otherwise the same words in
 * another order (`nameWords`) mean that row, unless two rows give them.
 */
function keyResolver<T>(
  keys: Iterable<readonly [key: string, row: T]>,
): (name: string) => T | undefined {
  const rowByKey = new Map<string, T>();
  // null marks a word key two rows give: the fallback picks neither.
  const rowByWords = new Map<string, T | null>();
  for (const [key, row] of keys) {
    if (!key) continue;
    if (!rowByKey.has(key)) rowByKey.set(key, row);
    const words = nameWords(key);
    const had = rowByWords.get(words);
    rowByWords.set(words, had === undefined || had === row ? row : null);
  }
  return (name) =>
    rowByKey.get(slugify(name)) ?? rowByWords.get(nameWords(name)) ?? undefined;
}

/** `[slug, row]` for each of a row's book aliases, the keys of the book tier. */
function bookAliasKeys<T extends NamedCharacter>(
  characters: T[],
): (readonly [string, T])[] {
  return characters.flatMap((row) =>
    (row.bookAliases ?? []).map((alias) => [slugify(alias), row] as const),
  );
}

/**
 * The one name rule for outside text (wiki names, new aliases): which
 * `characters` row a name means. The order:
 *
 * 1. A name that is exactly a row's `id`, as given (not slugified), is that
 *    row, so a caller holding an id always gets its row back.
 * 2. Slugified, a book alias of the book the rows were read for
 *    (`bookAliases`). It outranks every global key below, so "Yellow
 *    Dimension X Ranger" can be Michelangelo in one book though another
 *    character has that id (#893).
 * 3. Slugified, a row's id, then its display name, then a global alias.
 * 4. When none of those match, the same words in another order
 *    (`nameWords`) as any key above (ids, display names, aliases of either
 *    scope) mean that row, unless they mean two rows.
 *
 * Within one tier the first row in `characters` wins. A book alias wins only
 * on its exact slug: its words in another order go to tier 4 with the rest.
 */
export function nameResolver<T extends NamedCharacter>(
  characters: T[],
): (name: string) => T | undefined {
  const rowById = new Map<string, T>();
  for (const row of characters)
    if (!rowById.has(row.id)) rowById.set(row.id, row);
  const byKey = keyResolver([
    ...bookAliasKeys(characters),
    ...characters.map((row) => [row.id, row] as const),
    ...characters.map((row) => [slugify(row.display_name ?? ""), row] as const),
    ...characters.flatMap((row) =>
      row.aliases.map((alias) => [slugify(alias), row] as const),
    ),
  ]);
  return (name) => rowById.get(name) ?? byKey(name);
}

/** Every `characters` row's id and names, paged past the row cap. */
async function readCharacterRows(
  client: Client,
): Promise<Omit<NamedCharacter, "aliases">[]> {
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
  return rows;
}

/**
 * Every `characters` row with its global aliases, and with `bookId` that
 * book's too (also listed in `bookAliases`), for the name rule: hand it to
 * `nameResolver`, which has the order.
 */
export async function readNamedCharacters(
  client: Client,
  bookId?: string,
): Promise<NamedCharacter[]> {
  const rows = await readCharacterRows(client);
  const entries = await readAliasEntries(
    client,
    rows.map((r) => r.id),
    bookId,
  );
  return rows.map((r) => {
    const list = entries.get(r.id) ?? [];
    return {
      ...r,
      aliases: list.map((e) => e.alias),
      bookAliases: list.filter((e) => e.scope === "book").map((e) => e.alias),
    };
  });
}

/**
 * The name check an alias write in one scope makes. `characters` is every
 * `characters` row with only that scope's aliases, the global ones or
 * `bookId`'s book ones; `means` is who already holds a name there.
 *
 * - Global scope: ids, display names and global aliases hold a name, by the
 *   `nameResolver` rule over those rows.
 * - Book scope: only `bookId`'s book aliases hold one, on the exact slug,
 *   since that is all a book alias wins on in `nameResolver`. Another
 *   character's id or display name does not, because in that book the alias
 *   outranks them, and neither do the same words in another order: "Yellow
 *   Dimension X Ranger" can be added beside "Dimension X Yellow Ranger".
 *
 * A global alias does not block a book alias of the same name, nor a book
 * alias a global one.
 */
async function readScope(
  client: Client,
  bookId: string | null,
): Promise<{
  characters: NamedCharacter[];
  means: (name: string) => NamedCharacter | undefined;
}> {
  const rows = await readCharacterRows(client);
  const entries = await readAliasEntries(
    client,
    rows.map((r) => r.id),
    bookId ?? undefined,
  );
  const scope = bookId ? "book" : "global";
  const characters = rows.map((r) => {
    const aliases = (entries.get(r.id) ?? [])
      .filter((e) => e.scope === scope)
      .map((e) => e.alias);
    return { ...r, aliases, bookAliases: bookId ? aliases : undefined };
  });
  if (!bookId) return { characters, means: nameResolver(characters) };
  const holder = new Map<string, NamedCharacter>();
  for (const [key, row] of bookAliasKeys(characters))
    if (key && !holder.has(key)) holder.set(key, row);
  return { characters, means: (name) => holder.get(slugify(name)) };
}

/** The name rule over every `characters` row and its global aliases. */
export async function loadNameResolver(
  client: Client,
): Promise<(name: string) => NamedCharacter | undefined> {
  return nameResolver(await readNamedCharacters(client));
}

/** A name has a letter or a digit once slugified: "-" or "!!" is not one. */
export function isName(text: string): boolean {
  return /[a-z0-9]/.test(slugify(text));
}

/** `addAlias`'s refusal when the name already means another character, `by`. */
export class AliasTakenError extends Error {
  /** The refused name, as typed. */
  readonly alias: string;
  readonly by: NamedCharacter;
  constructor(name: string, by: NamedCharacter) {
    super(`aliases: "${name}" already means ${by.id}`);
    this.alias = name;
    this.by = by;
  }
}

/**
 * Makes a name resolve to a character by writing one `aliases` row,
 * `canonical` left null: a row of `bookId` when given, else a global one.
 * The name is checked in that scope only (`readScope`): a global alias is
 * refused when another character's id, display name or global alias holds
 * the name, a book alias only when another character's alias of that book
 * does. Either refusal is an `AliasTakenError`; the name already held by
 * this character there is false. True only when a row was written: when
 * the same name landed first (two adds racing), the name is checked again
 * and answers as above, or throws.
 */
export async function addAlias(
  client: Client,
  characterId: string,
  alias: string,
  bookId?: string,
): Promise<boolean> {
  const name = alias.trim();
  if (!isName(name)) throw new Error(`aliases: "${name}" is not a name`);
  const { characters, means: holder } = await readScope(client, bookId ?? null);
  const means = holder(name);
  if (means?.id === characterId) return false;
  if (means) throw new AliasTakenError(name, means);
  if (!characters.some((c) => c.id === characterId))
    throw new Error(`aliases: no character ${characterId}`);
  if (await insertAlias(client, characterId, name, bookId)) return true;
  // The row's (alias_norm, scope, scope_id) was taken after the check: say
  // who holds the name now.
  const now = (await readScope(client, bookId ?? null)).means(name);
  if (now?.id === characterId) return false;
  if (now) throw new AliasTakenError(name, now);
  throw new Error(`aliases: "${name}" was not written for ${characterId}`);
}

/**
 * Moves the alias row `aliasId` of `characterId` to the other scope: `book`
 * makes it a row of `bookId`, `global` a row for every book. The name is
 * checked in the new scope as `addAlias` checks it (`readScope`: in book
 * scope only that book's aliases hold a name), so a name another character
 * holds there is an `AliasTakenError`, and so is a row that took the key
 * after the check. Answers the alias's text, and whether the row
 * moved (false: it was already in that scope). Only a row `bookId`'s panel
 * shows can move: a global one, or one of `bookId`'s. Throws when the
 * character has no such row, when the row changed after it was read, or
 * when the character already has the same alias in the new scope.
 */
export async function setAliasScope(
  client: Client,
  aliasId: number,
  characterId: string,
  scope: "global" | "book",
  bookId: string,
): Promise<{ alias: string; moved: boolean }> {
  const { data: found, error } = await db(client)
    .from("aliases")
    .select("alias, scope, scope_id")
    .eq("id", aliasId)
    .eq("character_id", characterId)
    .maybeSingle();
  must(`reading alias ${aliasId} of ${characterId}`, error);
  // Another book's row is not this book's to move. Checked here rather than
  // in an `.or()` filter, so the book id is never spliced into filter syntax.
  const row =
    found &&
    (found.scope === "global" ||
      (found.scope === "book" && found.scope_id === bookId))
      ? found
      : null;
  if (!row) throw new Error(`aliases: ${characterId} has no alias ${aliasId}`);
  const scopeId = scope === "book" ? bookId : null;
  if (row.scope === scope && (row.scope_id ?? null) === scopeId)
    return { alias: row.alias, moved: false };

  const check = async () => {
    const { characters, means: holder } = await readScope(client, scopeId);
    const means = holder(row.alias);
    if (means && means.id !== characterId)
      throw new AliasTakenError(row.alias, means);
    // Its own row of the same name in the new scope: the table's key allows
    // only one.
    const mine = characters.find((c) => c.id === characterId);
    if (mine?.aliases.some((a) => slugify(a) === slugify(row.alias)))
      throw new Error(
        `aliases: ${characterId} already has "${row.alias}" as a ${scope} alias`,
      );
  };
  await check();
  // Only while the row still has the scope it was read with.
  const update = db(client)
    .from("aliases")
    .update({ scope, scope_id: scopeId })
    .eq("id", aliasId)
    .eq("character_id", characterId)
    .eq("scope", row.scope);
  const { data, error: writeError } = await (
    row.scope_id === null
      ? update.is("scope_id", null)
      : update.eq("scope_id", row.scope_id)
  ).select("id");
  // 23505: a row took the new scope's key after the check; say whose.
  if (writeError?.code === "23505") await check();
  must(`moving alias ${aliasId} of ${characterId}`, writeError);
  if (!data?.length)
    throw new Error(
      `The alias "${row.alias}" changed elsewhere. Reload the page and try again.`,
    );
  return { alias: row.alias, moved: true };
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
  await insertAlias(client, characterId, alias, bookId);
}

/** `writeAlias`'s upsert, answering whether it inserted a row (false: the key was already held). */
async function insertAlias(
  client: Client,
  characterId: string,
  alias: string,
  bookId?: string,
): Promise<boolean> {
  const { data, error } = await db(client)
    .from("aliases")
    .upsert(
      {
        alias,
        character_id: characterId,
        scope: bookId ? "book" : "global",
        scope_id: bookId ?? null,
      },
      { onConflict: "alias_norm,scope,scope_id", ignoreDuplicates: true },
    )
    .select("id");
  must(`writing the alias "${alias}" for ${characterId}`, error);
  return (data?.length ?? 0) > 0;
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

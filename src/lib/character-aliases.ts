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

/**
 * The aliases of each character in `characterIds`, keyed by `character_id`,
 * each list in the order the rows were written. Global rows always; with
 * `bookId`, that book's rows too. A character with none is left out of the
 * map. Throws on a failed read.
 */
export async function readAliases(
  client: Client,
  characterIds: Iterable<string>,
  bookId?: string,
): Promise<Map<string, string[]>> {
  const ids = [...new Set(characterIds)];
  const scope = bookId
    ? `scope.eq.global,and(scope.eq.book,scope_id.eq.${bookId})`
    : "scope.eq.global";
  const out = new Map<string, string[]>();
  for (let i = 0; i < ids.length; i += IDS_PER_READ) {
    const chunk = ids.slice(i, i + IDS_PER_READ);
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db(client)
        .from("aliases")
        .select("alias, character_id")
        .in("character_id", chunk)
        .or(scope)
        .order("id")
        .range(from, from + PAGE - 1);
      must("reading aliases", error);
      const rows = data ?? [];
      for (const row of rows) {
        if (!row.character_id) continue;
        const list = out.get(row.character_id) ?? [];
        list.push(row.alias);
        out.set(row.character_id, list);
      }
      if (rows.length < PAGE) break;
    }
  }
  return out;
}

/** A `characters` row as the name rule reads it. */
export interface NamedCharacter {
  id: string;
  display_name: string | null;
  aliases: string[];
}

/**
 * The one name rule for outside text (wiki names, new aliases): a name means
 * a `characters` row when, slugified, it is the row's id, display name or an
 * alias. Ids win over display names, display names over aliases.
 */
export function nameResolver<T extends NamedCharacter>(
  characters: T[],
): (name: string) => T | undefined {
  const rowByKey = new Map<string, T>();
  const index = (key: string, row: T) => {
    if (key && !rowByKey.has(key)) rowByKey.set(key, row);
  };
  for (const row of characters) index(row.id, row);
  for (const row of characters) index(slugify(row.display_name ?? ""), row);
  for (const row of characters)
    for (const alias of row.aliases) index(slugify(alias), row);
  return (name) => rowByKey.get(slugify(name));
}

/** Every `characters` row with its global aliases, for the name rule. */
export async function readNamedCharacters(
  client: Client,
): Promise<NamedCharacter[]> {
  const rows: { id: string; display_name: string | null }[] = [];
  for (;;) {
    const { data, error } = await db(client)
      .from("characters")
      .select("id, display_name")
      .order("id")
      .range(rows.length, rows.length + PAGE - 1);
    must("reading characters", error);
    if (!data?.length) break;
    rows.push(...data);
  }
  const aliases = await readAliases(
    client,
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({ ...r, aliases: aliases.get(r.id) ?? [] }));
}

/** The name rule over every `characters` row and its global aliases. */
export async function loadNameResolver(
  client: Client,
): Promise<(name: string) => NamedCharacter | undefined> {
  return nameResolver(await readNamedCharacters(client));
}

/**
 * Makes a name resolve to a character by writing one `aliases` row,
 * `canonical` left null, scope global unless `bookId` is given. False when
 * the name already means that character, a throw when it means another. A
 * row the table already holds under (alias_norm, scope, scope_id) is left as
 * it is.
 */
export async function addAlias(
  client: Client,
  characterId: string,
  alias: string,
  bookId?: string,
): Promise<boolean> {
  const name = alias.trim();
  if (!slugify(name)) throw new Error(`aliases: "${name}" is not a name`);
  const characters = await readNamedCharacters(client);
  const means = nameResolver(characters)(name);
  if (means?.id === characterId) return false;
  if (means) throw new Error(`aliases: "${name}" already means ${means.id}`);
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

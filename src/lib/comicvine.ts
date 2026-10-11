/**
 * Comic Vine (#851): an issue's character credits, with each character's
 * aliases, one-line deck and reference image URL, stored on
 * `issues.comicvine_characters`. The book's volume is
 * `books.comicvine_volume_id`, set by hand once per book and never guessed.
 * The lookahead (`src/workflows/steps/vision.ts`) adds the names and decks to
 * its face prompt; the characters stop (`src/lib/cast.ts`) suggests the names.
 * The image URL is stored only: Comic Vine art is never sent to Gemini, never
 * stored as an exemplar and never embedded.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { selectIssue, updateIssue } from "~/lib/issue-queries";
import type { Database, Json } from "~/types/database";

/** One stored credit. `[]` on the row means fetched, no credits; null means not fetched yet. */
export interface ComicVineCharacter {
  id: number;
  name: string;
  aliases: string[];
  deck: string | null;
  image_url: string | null;
}

const API = "https://comicvine.gamespot.com/api";
// Comic Vine blocks the default fetch User-Agent.
const USER_AGENT =
  "comic-reader/1.0 (family comic reader; character lookahead)";
const TIMEOUT_MS = 15_000;
const PAGE_LIMIT = 100;

/** Trims, and drops the zero-width characters Comic Vine text carries. */
function clean(s: string): string {
  return s.replace(/[​﻿]/g, "").trim();
}

/**
 * The first sentence of a deck, cut at a word to at most `max` characters
 * with an ellipsis; null for an empty deck.
 */
export function deckSentence(deck: string | null, max: number): string | null {
  if (!deck) return null;
  const text = clean(deck).replace(/\s+/g, " ");
  if (!text) return null;
  const end = /[.!?](?=\s|$)/.exec(text);
  const sentence = end ? text.slice(0, end.index + 1) : text;
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > 0 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, "")}…`;
}

/** A name for matching: lowercased, punctuation dropped, `-` and `_` as spaces. */
export function normalizeCastName(name: string): string {
  return clean(name)
    .toLowerCase()
    .replace(/[-_]/g, " ")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The wiki's first-and-last-word rule: two-plus words each, the same first and last word. */
export function sameFirstAndLastWord(a: string, b: string): boolean {
  const wa = a.split(" ");
  const wb = b.split(" ");
  return (
    wa.length >= 2 &&
    wb.length >= 2 &&
    wa[0] === wb[0] &&
    wa[wa.length - 1] === wb[wb.length - 1]
  );
}

/**
 * The known name a Comic Vine credit is, or undefined: one whose normalized
 * form equals the credit's name, then one that equals an alias, then one that
 * shares the first and last word with the credit's name (never an alias's),
 * unless `exactOnly`. Known names are tried in order within each test. The
 * lookahead's name list uses all three; the characters stop's suggestions use
 * `exactOnly`. Neither ever matches one credit against another.
 */
export function matchCredit<T>(
  credit: Pick<ComicVineCharacter, "name" | "aliases">,
  known: { name: string; value: T }[],
  exactOnly = false,
): T | undefined {
  const norms = known.map((k) => ({
    norm: normalizeCastName(k.name),
    value: k.value,
  }));
  const equal = (n: string) => norms.find((k) => k.norm === n);
  const name = normalizeCastName(credit.name);
  const hit =
    equal(name) ??
    credit.aliases.map((a) => equal(normalizeCastName(a))).find(Boolean) ??
    (exactOnly
      ? undefined
      : norms.find((k) => sameFirstAndLastWord(k.norm, name)));
  return hit?.value;
}

/** `issues.comicvine_characters` as stored credits, whatever the JSON holds; null when not fetched. */
export function parseComicVineCharacters(
  value: unknown,
): ComicVineCharacter[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((entry: unknown): ComicVineCharacter[] => {
    if (!entry || typeof entry !== "object") return [];
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "number" || typeof e.name !== "string") return [];
    const name = clean(e.name);
    if (!name) return [];
    const aliases = Array.isArray(e.aliases)
      ? e.aliases.flatMap((a: unknown) =>
          typeof a === "string" && clean(a) ? [clean(a)] : [],
        )
      : [];
    const deck = typeof e.deck === "string" && clean(e.deck) ? e.deck : null;
    return [
      {
        id: e.id,
        name,
        aliases,
        deck: deck ? clean(deck) : null,
        image_url: typeof e.image_url === "string" ? e.image_url : null,
      },
    ];
  });
}

type ApiBody = { status_code?: unknown; error?: unknown; results?: unknown };

/** One GET; throws on an HTTP error, a timeout, or a non-1 `status_code`. */
async function get(
  apiKey: string,
  path: string,
  params: Record<string, string>,
): Promise<unknown> {
  const qs = new URLSearchParams({
    ...params,
    api_key: apiKey,
    format: "json",
  });
  const res = await fetch(`${API}/${path}?${qs.toString()}`, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);
  const body = (await res.json()) as ApiBody;
  if (body.status_code !== 1) {
    throw new Error(
      `status_code ${String(body.status_code)} (${String(body.error)}) on ${path}`,
    );
  }
  return body.results;
}

/** One `characters/` row as a stored credit; throws when it has the wrong shape. */
function creditFromApi(row: unknown): ComicVineCharacter {
  const r = (row ?? {}) as Record<string, unknown>;
  const image = r.image as Record<string, unknown> | null | undefined;
  const stringOrNull = (key: string) =>
    key in r && (r[key] === null || typeof r[key] === "string");
  if (
    typeof r.id !== "number" ||
    typeof r.name !== "string" ||
    !clean(r.name) ||
    !stringOrNull("aliases") ||
    !stringOrNull("deck") ||
    !("image" in r) ||
    (image !== null &&
      (typeof image !== "object" ||
        Array.isArray(image) ||
        (image.medium_url !== undefined &&
          typeof image.medium_url !== "string")))
  ) {
    throw new Error(`malformed character ${JSON.stringify(r.id ?? null)}`);
  }
  const deck = typeof r.deck === "string" ? clean(r.deck) : "";
  return {
    id: r.id,
    name: clean(r.name),
    aliases:
      typeof r.aliases === "string"
        ? r.aliases.split(/\r?\n/).map(clean).filter(Boolean)
        : [],
    deck: deck || null,
    image_url: typeof image?.medium_url === "string" ? image.medium_url : null,
  };
}

/**
 * The issue's character credits from Comic Vine: one call for the issue id,
 * one for its credits, and one per 100 characters for their details. Throws
 * on any failure, including a null `results`, a missing `character_credits`
 * array, or details that do not cover every credited id, so only a complete
 * fetch is stored. `[]` only when Comic Vine lists the issue with no credits.
 */
export async function fetchComicVineCast(
  apiKey: string,
  volumeId: number,
  issueNumber: number,
): Promise<ComicVineCharacter[]> {
  const issues = await get(apiKey, "issues/", {
    filter: `volume:${volumeId},issue_number:${issueNumber}`,
    field_list: "id",
  });
  if (!Array.isArray(issues)) throw new Error("issues/ results not a list");
  const issueId = (issues[0] as { id?: unknown } | undefined)?.id;
  if (typeof issueId !== "number") {
    throw new Error(`no issue ${issueNumber} in volume ${volumeId}`);
  }

  const detail = await get(apiKey, `issue/4000-${issueId}/`, {
    field_list: "character_credits",
  });
  const credits = (detail as { character_credits?: unknown } | null)
    ?.character_credits;
  if (!Array.isArray(credits)) {
    throw new Error(`issue ${issueId} has no character_credits list`);
  }
  const ids: number[] = [];
  for (const c of credits as unknown[]) {
    const id = (c as { id?: unknown } | null)?.id;
    if (typeof id !== "number") {
      throw new Error(`issue ${issueId} has a credit without an id`);
    }
    if (!ids.includes(id)) ids.push(id);
  }

  const byId = new Map<number, ComicVineCharacter>();
  for (let i = 0; i < ids.length; i += PAGE_LIMIT) {
    const rows = await get(apiKey, "characters/", {
      filter: `id:${ids.slice(i, i + PAGE_LIMIT).join("|")}`,
      field_list: "id,name,aliases,deck,image",
      limit: String(PAGE_LIMIT),
    });
    if (!Array.isArray(rows)) {
      throw new Error("characters/ results not a list");
    }
    for (const row of rows as unknown[]) {
      const c = creditFromApi(row);
      byId.set(c.id, c);
    }
  }
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new Error(
      `details cover ${ids.length - missing.length} of ${ids.length} credits`,
    );
  }
  // Credit order, which is how Comic Vine lists the issue's cast.
  return ids.map((id) => byId.get(id)!);
}

/**
 * The fetch step's Comic Vine half, next to the wiki fetch. Skips when the
 * row already holds credits (a resume never refetches), when the book has no
 * `comicvine_volume_id`, or when `COMICVINE_API_KEY` is unset. Any Comic Vine
 * failure logs one line and leaves the column null, so a later run retries.
 */
export async function fetchAndStoreComicVineCast(
  supabase: SupabaseClient,
  bookId: string,
  issueId: string,
): Promise<ComicVineCharacter[] | null> {
  const db = supabase as SupabaseClient<Database>;
  const { data: book, error: bookErr } = await db
    .from("books")
    .select("comicvine_volume_id")
    .eq("id", bookId)
    .maybeSingle();
  if (bookErr) {
    console.warn(
      `[comicvine] ${bookId}: books read failed: ${bookErr.message}`,
    );
    return null;
  }
  const volumeId = book?.comicvine_volume_id;
  if (!volumeId) {
    console.log(`[comicvine] ${bookId}: no comicvine_volume_id — skip`);
    return null;
  }

  const { data: issue, error: issueErr } = await selectIssue(
    supabase,
    bookId,
    issueId,
    "number, comicvine_characters",
  ).maybeSingle();
  if (issueErr || !issue) {
    console.warn(
      `[comicvine] ${bookId}/${issueId}: issue read failed: ${issueErr?.message ?? "not found"}`,
    );
    return null;
  }
  const stored = parseComicVineCharacters(issue.comicvine_characters);
  if (stored) {
    console.log(
      `[comicvine] ${bookId}/${issueId}: already has ${stored.length} credits — skip`,
    );
    return stored;
  }

  const apiKey = process.env.COMICVINE_API_KEY;
  if (!apiKey) {
    console.log(
      `[comicvine] ${bookId}/${issueId}: COMICVINE_API_KEY unset — skip`,
    );
    return null;
  }

  let cast: ComicVineCharacter[];
  try {
    cast = await fetchComicVineCast(apiKey, volumeId, Number(issue.number));
  } catch (err: unknown) {
    console.warn(
      `[comicvine] ${bookId}/${issueId}: fetch failed, wiki names only: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  const { error } = await updateIssue(supabase, bookId, issueId, {
    comicvine_characters: cast as unknown as Json,
  });
  if (error) {
    console.warn(
      `[comicvine] ${bookId}/${issueId}: DB update failed: ${error.message}`,
    );
    return null;
  }
  console.log(
    `[comicvine] ${bookId}/${issueId}: saved ${cast.length} credits (volume ${volumeId})`,
  );
  return cast;
}

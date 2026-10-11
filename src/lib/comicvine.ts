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

/**
 * The issue's character credits from Comic Vine: one call for the issue id,
 * one for its credits, and one per 100 characters for their details. Throws
 * on any failure; `[]` when the issue has no credits.
 */
export async function fetchComicVineCast(
  apiKey: string,
  volumeId: number,
  issueNumber: number,
): Promise<ComicVineCharacter[]> {
  const issues = (await get(apiKey, "issues/", {
    filter: `volume:${volumeId},issue_number:${issueNumber}`,
    field_list: "id",
  })) as { id?: unknown }[] | undefined;
  const issueId = issues?.[0]?.id;
  if (typeof issueId !== "number") {
    throw new Error(`no issue ${issueNumber} in volume ${volumeId}`);
  }

  const detail = (await get(apiKey, `issue/4000-${issueId}/`, {
    field_list: "character_credits",
  })) as { character_credits?: { id?: unknown }[] | null } | undefined;
  const ids = (detail?.character_credits ?? []).flatMap((c) =>
    typeof c.id === "number" ? [c.id] : [],
  );

  const byId = new Map<number, ComicVineCharacter>();
  for (let i = 0; i < ids.length; i += PAGE_LIMIT) {
    const rows = (await get(apiKey, "characters/", {
      filter: `id:${ids.slice(i, i + PAGE_LIMIT).join("|")}`,
      field_list: "id,name,aliases,deck,image",
      limit: String(PAGE_LIMIT),
    })) as {
      id?: unknown;
      name?: unknown;
      aliases?: unknown;
      deck?: unknown;
      image?: { medium_url?: unknown } | null;
    }[];
    const parsed = parseComicVineCharacters(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        aliases: typeof r.aliases === "string" ? r.aliases.split(/\r?\n/) : [],
        deck: r.deck,
        image_url: r.image?.medium_url,
      })),
    );
    for (const c of parsed ?? []) byId.set(c.id, c);
  }
  // Credit order, which is how Comic Vine lists the issue's cast.
  return ids.flatMap((id) => {
    const c = byId.get(id);
    return c ? [c] : [];
  });
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

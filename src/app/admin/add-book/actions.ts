"use server";

import { createPartFromText } from "@google/genai";
import { franchiseSlug } from "~/lib/character-id";
import { getGeminiClient } from "~/lib/gemini-client";
import { generateContentLogged } from "~/lib/llm-usage";
import { GEMINI_MEDIUM } from "~/lib/models";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { requireAdmin } from "~/server/admin/require-admin";
import {
  bookIdFromTitle,
  bookSearchReply,
  matchSeries,
  volumeOrNull,
  type SeriesMatch,
} from "../add/model";

type Ok<T> = { ok: true; data: T };
type Err = { ok: false; error: string };
type Result<T> = Ok<T> | Err;

export interface BookSearchResult {
  title: string;
  wikiUrl: string | null;
  wikiHost: string | null;
  publisher: string | null;
  franchises: string[];
  /** The multi-volume series this book belongs to; null when standalone. */
  seriesName: string | null;
  /** This book's volume within that series; null when standalone. */
  volumeNumber: number | null;
  /** The `series.id` createBook will store, and whether that row exists yet. */
  seriesId: string | null;
  seriesIsNew: boolean;
  /** This volume's issue count only. */
  totalIssues: number | null;
  wikiTitleTemplate: string | null;
  suggestedSlug: string;
}

/**
 * The series a book joins, by `matchSeries` against every `series` row.
 * The match runs here, not as an ilike filter, because PostgREST reads `*`
 * in an ilike value as a wildcard; the table holds one row per series.
 */
async function resolveSeries(
  name: string | null | undefined,
): Promise<Result<SeriesMatch | null>> {
  if (!matchSeries([], name)) return { ok: true, data: null };
  const { data: rows, error } = (await supabaseAdmin
    .from("series")
    .select("id, name")) as {
    data: { id: string; name: string }[] | null;
    error: { message: string } | null;
  };
  if (error) return { ok: false, error: error.message };
  return { ok: true, data: matchSeries(rows ?? [], name) };
}

/** The unique (series_id, series_position) violation, as a person reads it. */
function takenVolume(
  error: { code?: string; message: string },
  position: number | null,
  series: SeriesMatch | null,
): string | null {
  return error.code === "23505" &&
    error.message.includes("books_series_id_series_position_key")
    ? `Another book is already volume ${position} of the ${series?.name} series.`
    : null;
}

export async function searchForBook(
  query: string,
): Promise<Result<BookSearchResult>> {
  if (!query.trim()) return { ok: false, error: "Query is required" };

  const prompt = `Find the fandom wiki page for this comic book series: "${query}"

Return a JSON object with:
- title: full official title of the comic series
- wikiUrl: URL of the fandom wiki page for the series (not a specific issue)
- wikiHost: hostname (e.g., "powerrangers.fandom.com")
- publisher: publisher name
- franchises: array of franchise names involved
- seriesName: if this comic is one volume of a multi-volume series (e.g., "Part III" of a three-part crossover), the name of the whole series. Otherwise null.
- volumeNumber: if seriesName is set, this comic's volume number within the series (e.g., 3 for "Part III"). Otherwise null.
- totalIssues: number of issues in this volume only (not the whole series)
- wikiTitleTemplate: the URL path pattern for this volume's individual issues, with {number} as placeholder

Return JSON only, no markdown.`;

  try {
    await requireAdmin();
    const response = await generateContentLogged(
      getGeminiClient(),
      {
        model: GEMINI_MEDIUM,
        contents: [createPartFromText(prompt)],
        config: {
          tools: [{ googleSearch: {} }],
        },
      },
      { step: "admin:add-book:search" },
    );

    const text = response.text?.trim();
    if (!text) return { ok: false, error: "Empty response from Gemini" };

    const reply = bookSearchReply(text);
    if (!reply.ok) return reply;
    const parsed = reply.data;
    const series = await resolveSeries(parsed.seriesName);
    if (!series.ok) return series;

    return {
      ok: true,
      data: {
        ...parsed,
        seriesName: series.data?.name ?? null,
        volumeNumber: series.data ? volumeOrNull(parsed.volumeNumber) : null,
        seriesId: series.data?.id ?? null,
        seriesIsNew: series.data?.isNew ?? false,
        suggestedSlug: bookIdFromTitle(parsed.title),
      },
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Unknown error",
    };
  }
}

interface CreateBookArgs {
  slug: string;
  title: string;
  wikiHost: string | null;
  wikiTitleTemplate: string | null;
  publisher: string | null;
  franchises: string[];
  totalIssues: number | null;
  seriesName: string | null;
  volumeNumber: number | null;
  /** Standalone books to put in the book's series, each at its volume. */
  attach?: { bookId: string; position: number }[];
}

/**
 * Writes the series row, the book, the attached books, then the franchise
 * links. Once the book is in, a later failure returns its error prefixed
 * with the part that failed (`Series books not saved:`, `Franchise links not
 * saved:`), so the flow keeps the book and warns.
 */
export async function createBook(
  args: CreateBookArgs,
): Promise<Result<{ id: string }>> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const {
    slug,
    title,
    wikiHost,
    wikiTitleTemplate,
    publisher,
    franchises,
    totalIssues,
    seriesName,
    volumeNumber,
    attach = [],
  } = args;

  if (!slug || !title)
    return { ok: false, error: "Slug and title are required" };

  // The book's series, written insert-only the way franchises are.
  const resolved = await resolveSeries(seriesName);
  if (!resolved.ok) return resolved;
  const series = resolved.data;
  const seriesId = series?.id ?? null;
  const position = series ? volumeOrNull(volumeNumber) : null;
  // `created` is true only when this call inserted the row: an ignored
  // duplicate returns no row.
  let created = false;
  if (series?.isNew) {
    const { data: inserted, error: seriesError } = await supabaseAdmin
      .from("series")
      .upsert(
        { id: series.id, name: series.name },
        { onConflict: "id", ignoreDuplicates: true },
      )
      .select("id");
    if (seriesError) return { ok: false, error: seriesError.message };
    created = (inserted ?? []).length > 0;
  }

  const { error: bookError } = await supabaseAdmin.from("books").insert({
    id: slug,
    slug,
    name: title,
    wiki_host: wikiHost,
    wiki_title_template: wikiTitleTemplate,
    publisher,
    total_issues: totalIssues,
    series_id: seriesId,
    series_position: position,
    // #131: a book is a draft until the owner publishes it from /admin, so a
    // book added ahead of the pipeline never shows kids an empty cover.
    published: false,
  });

  if (bookError) {
    // A series row this call created has no book in it now; remove it
    // unless another book joined it meanwhile.
    if (series && created) {
      const { count } = await supabaseAdmin
        .from("books")
        .select("id", { count: "exact", head: true })
        .eq("series_id", series.id);
      if (count === 0)
        await supabaseAdmin.from("series").delete().eq("id", series.id);
    }
    return {
      ok: false,
      error: takenVolume(bookError, position, series) ?? bookError.message,
    };
  }

  // Earlier books join the series. Only a book with no series is moved, so a
  // stale list never takes a book out of another series.
  const problems: string[] = [];
  for (const a of series ? attach : []) {
    const at = volumeOrNull(a.position);
    const { data: moved, error: attachError } = at
      ? await supabaseAdmin
          .from("books")
          .update({ series_id: seriesId, series_position: at })
          .eq("id", a.bookId)
          .is("series_id", null)
          .select("id")
      : { data: null, error: { message: `${a.bookId} needs a volume.` } };
    const failed = attachError
      ? (takenVolume(attachError, at, series) ?? attachError.message)
      : (moved ?? []).length === 0
        ? `${a.bookId} is already in a series.`
        : null;
    if (failed) {
      problems.push(`Series books not saved: ${failed}`);
      break;
    }
  }

  // One `franchises` row per name (an existing id is left as it is) and one
  // `book_franchises` row per name, `position` its index; the first name is
  // the default franchise for a character created in this book.
  const named = new Map<string, { name: string; position: number }>();
  franchises.forEach((name, position) => {
    const id = franchiseSlug(name);
    if (id && !named.has(id)) named.set(id, { name: name.trim(), position });
  });
  if (named.size > 0) {
    const { error: franchiseError } = await supabaseAdmin
      .from("franchises")
      .upsert(
        [...named].map(([id, f]) => ({ id, name: f.name })),
        { onConflict: "id", ignoreDuplicates: true },
      );
    const { error: linkError } = franchiseError
      ? { error: franchiseError }
      : await supabaseAdmin.from("book_franchises").insert(
          [...named].map(([id, f]) => ({
            book_id: slug,
            franchise_id: id,
            position: f.position,
          })),
        );
    if (linkError)
      problems.push(`Franchise links not saved: ${linkError.message}`);
  }

  return problems.length > 0
    ? { ok: false, error: problems.join(" ") }
    : { ok: true, data: { id: slug } };
}

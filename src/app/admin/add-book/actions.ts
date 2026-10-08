"use server";

import { createPartFromText } from "@google/genai";
import { franchiseSlug } from "~/lib/character-id";
import { getGeminiClient } from "~/lib/gemini-client";
import { generateContentLogged } from "~/lib/llm-usage";
import { GEMINI_MEDIUM } from "~/lib/models";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { requireAdmin } from "~/server/admin/require-admin";

type Ok<T> = { ok: true; data: T };
type Err = { ok: false; error: string };
type Result<T> = Ok<T> | Err;

export interface BookSearchResult {
  title: string;
  wikiUrl: string;
  wikiHost: string;
  publisher: string;
  franchises: string[];
  /** The multi-volume series this book belongs to; null when standalone. */
  seriesName: string | null;
  /** This book's volume within that series; null when standalone. */
  volumeNumber: number | null;
  /** The `series.id` createBook will store, and whether that row exists yet. */
  seriesId: string | null;
  seriesIsNew: boolean;
  /** This volume's issue count only. */
  totalIssues: number;
  wikiTitleTemplate: string;
  suggestedSlug: string;
}

function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

/**
 * The series a book joins: an existing row whose id is the name's slug, or
 * whose name matches ignoring case, spacing and punctuation, keeps its id, so a later volume lands in the same
 * series; otherwise the id a new row would get. Null when there is no name.
 * The match runs here, not as an ilike filter, because PostgREST reads `*`
 * in an ilike value as a wildcard; the table holds one row per series.
 */
async function resolveSeries(
  name: string | null | undefined,
): Promise<Result<{ id: string; name: string; isNew: boolean } | null>> {
  const series = name?.trim();
  const slug = series ? franchiseSlug(series) : "";
  if (!series || !slug) return { ok: true, data: null };
  const { data: rows, error } = (await supabaseAdmin
    .from("series")
    .select("id, name")) as {
    data: { id: string; name: string }[] | null;
    error: { message: string } | null;
  };
  if (error) return { ok: false, error: error.message };
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const existing = (rows ?? []).find(
    (r) => r.id === slug || key(r.name) === key(series),
  );
  return {
    ok: true,
    data: existing
      ? { id: existing.id, name: existing.name, isNew: false }
      : { id: slug, name: series, isNew: true },
  };
}

/** Gemini's volume number, kept only when it is a positive integer. */
function volumeOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
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

    const cleaned = text.replace(/^```json?\s*/, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(cleaned) as Omit<
      BookSearchResult,
      "suggestedSlug" | "seriesId" | "seriesIsNew"
    >;
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
        suggestedSlug: generateSlug(parsed.title),
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
  wikiHost: string;
  wikiTitleTemplate: string;
  publisher: string;
  franchises: string[];
  totalIssues: number;
  seriesName: string | null;
  volumeNumber: number | null;
}

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
    if (
      bookError.code === "23505" &&
      bookError.message.includes("books_series_id_series_position_key")
    ) {
      return {
        ok: false,
        error: `Another book is already volume ${position} of the ${series?.name} series.`,
      };
    }
    return { ok: false, error: bookError.message };
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
    if (franchiseError) return { ok: false, error: franchiseError.message };
    const { error: linkError } = await supabaseAdmin
      .from("book_franchises")
      .insert(
        [...named].map(([id, f]) => ({
          book_id: slug,
          franchise_id: id,
          position: f.position,
        })),
      );
    if (linkError) return { ok: false, error: linkError.message };
  }

  return { ok: true, data: { id: slug } };
}

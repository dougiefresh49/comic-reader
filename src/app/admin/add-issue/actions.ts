"use server";

import { supabaseAdmin } from "~/lib/supabase-admin";
import { GEMINI_MEDIUM } from "~/lib/models";
import { createPartFromText } from "@google/genai";
import { getGeminiClient } from "~/lib/gemini-client";
import { generateContentLogged } from "~/lib/llm-usage";
import {
  insertIssue,
  listBookIssues,
  selectIssue,
  updateIssue,
} from "~/lib/issue-queries";
import { findOnGrabberZone, seriesTerms } from "~/lib/add-content/grabber-zone";
import {
  extractPageImageUrls,
  fetchHtml,
  siteNameFrom,
} from "~/lib/add-content/page-images";
import {
  fetchWikiCoverUrl,
  wikiPageTitle,
  wikiTitleWords,
} from "~/lib/add-content/wiki";
import { requireAdmin } from "~/server/admin/require-admin";

type Ok<T> = { ok: true; data: T };
type Err = { ok: false; error: string };
type Result<T> = Ok<T> | Err;

// ─── getBookInfo ─────────────────────────────────────────────────────────────

interface BookInfo {
  name: string;
  totalIssues: number | null;
  wikiHost: string | null;
  wikiTitleTemplate: string | null;
  nextIssueNumber: number;
}

export async function getBookInfo(bookId: string): Promise<Result<BookInfo>> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const { data: book, error: bookErr } = (await supabaseAdmin
    .from("books")
    .select("id, name, total_issues, wiki_host, wiki_title_template")
    .eq("id", bookId)
    .single()) as {
    data: {
      id: string;
      name: string;
      total_issues: number | null;
      wiki_host: string | null;
      wiki_title_template: string | null;
    } | null;
    error: { message: string } | null;
  };

  if (bookErr || !book) {
    return { ok: false, error: bookErr?.message ?? "Book not found" };
  }

  const { data: maxIssue } = (await listBookIssues(
    supabaseAdmin,
    bookId,
    "number",
  )
    .order("number", { ascending: false })
    .limit(1)
    .single()) as { data: { number: number } | null };

  return {
    ok: true,
    data: {
      name: book.name,
      totalIssues: book.total_issues,
      wikiHost: book.wiki_host,
      wikiTitleTemplate: book.wiki_title_template,
      nextIssueNumber: (maxIssue?.number ?? 0) + 1,
    },
  };
}

// ─── findReadingSource ───────────────────────────────────────────────────────

interface BookSearchInfo {
  name: string;
  wiki_host: string | null;
  wiki_title_template: string | null;
}

async function loadBookSearchInfo(bookId: string): Promise<BookSearchInfo> {
  const { data, error } = (await supabaseAdmin
    .from("books")
    .select("name, wiki_host, wiki_title_template")
    .eq("id", bookId)
    .single()) as {
    data: BookSearchInfo | null;
    error: { message: string } | null;
  };
  if (error || !data) throw new Error(error?.message ?? "Book not found");
  return data;
}

/** The wiki title as words; the book name only when the book has no template. */
function issueSearchTitle(book: BookSearchInfo, issueNumber: number): string {
  return book.wiki_title_template
    ? wikiTitleWords(book.wiki_title_template, issueNumber)
    : `${book.name} Issue ${issueNumber}`;
}

interface ReadingSource {
  url: string;
  siteName: string;
  confidence: "high" | "medium" | "low";
  /** What was searched, shown beside the result. */
  query: string;
}

/**
 * grabber.zone first (plain fetches, no Gemini), then the Gemini grounded
 * search. Both use the issue's wiki title and any extra context (#792).
 */
export async function findReadingSource(args: {
  bookId: string;
  issueNumber: number;
  extraContext?: string;
}): Promise<Result<ReadingSource>> {
  try {
    await requireAdmin();
    const book = await loadBookSearchInfo(args.bookId);
    const title = issueSearchTitle(book, args.issueNumber);
    const extraContext = args.extraContext?.trim().slice(0, 300) ?? "";

    const terms = seriesTerms(title, args.issueNumber);
    try {
      const match = await findOnGrabberZone({
        terms,
        issueNumber: args.issueNumber,
        extraContext,
      });
      if (match) {
        return {
          ok: true,
          data: {
            url: match.url,
            siteName: "grabber.zone",
            confidence: "high",
            query: `grabber.zone: ${[terms, extraContext].join(" ").trim()}, issue ${args.issueNumber}`,
          },
        };
      }
    } catch (e) {
      // grabber.zone down or changed: the open search still runs.
      console.warn("findReadingSource: grabber.zone search failed:", e);
    }

    const query = extraContext ? `"${title}" ${extraContext}` : `"${title}"`;
    const prompt = `Find a URL where I can read the comic ${query} online for free. It must be that exact issue (issue #${args.issueNumber}), not another issue or another series with a similar name.${extraContext ? ` Extra context: ${extraContext}.` : ""} Return ONLY a JSON object with these fields: { "url": string, "siteName": string, "confidence": "high" | "medium" | "low" }. No explanation, no markdown fences.`;

    const response = await generateContentLogged(
      getGeminiClient(),
      {
        model: GEMINI_MEDIUM,
        contents: [createPartFromText(prompt)],
        config: {
          tools: [{ googleSearch: {} }],
        },
      },
      { step: "admin:add-issue:find-source" },
    );

    const text = response.text?.trim();
    if (!text) {
      return { ok: false, error: "Gemini returned empty response" };
    }

    // Strip markdown fences if Gemini ignores instruction
    const cleaned = text.replace(/^```json?\n?/i, "").replace(/\n?```$/i, "");
    const parsed = JSON.parse(cleaned) as Omit<ReadingSource, "query">;

    if (!parsed.url || !parsed.siteName) {
      return { ok: false, error: "Gemini response missing required fields" };
    }

    return {
      ok: true,
      data: { ...parsed, query: `web search: ${query}` },
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Unknown error",
    };
  }
}

// ─── previewSource ───────────────────────────────────────────────────────────

export interface SourcePreview {
  siteName: string;
  url: string;
  imageUrls: string[];
  firstImageUrl: string | null;
  wikiCoverUrl: string | null;
}

/**
 * The Check step: one plain fetch of the source page, its page images, and
 * the wiki cover to compare with. No Gemini, no browser, no writes (#792).
 */
export async function previewSource(args: {
  bookId: string;
  issueNumber: number;
  url: string;
}): Promise<Result<SourcePreview>> {
  try {
    await requireAdmin();
    const url = new URL(args.url.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return { ok: false, error: "The source must be an http(s) URL." };
    }
    const book = await loadBookSearchInfo(args.bookId);

    const [html, wikiCoverUrl] = await Promise.all([
      fetchHtml(url.href),
      book.wiki_host && book.wiki_title_template
        ? fetchWikiCoverUrl(
            book.wiki_host,
            wikiPageTitle(book.wiki_title_template, args.issueNumber),
          )
        : Promise.resolve(null),
    ]);
    const imageUrls = extractPageImageUrls(html, url.href);

    return {
      ok: true,
      data: {
        siteName: siteNameFrom(html, url.href),
        url: url.href,
        imageUrls,
        firstImageUrl: imageUrls[0] ?? null,
        wikiCoverUrl,
      },
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Unknown error",
    };
  }
}

// ─── createIssue ─────────────────────────────────────────────────────────────

interface CreateIssueArgs {
  bookId: string;
  issueNumber: number;
  wikiUrl: string;
  sourceUrl: string;
}

export async function createIssue(
  args: CreateIssueArgs,
): Promise<Result<{ id: string }>> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const issueId = `issue-${args.issueNumber}`;
  const { data: existing, error: lookupErr } = await selectIssue(
    supabaseAdmin,
    args.bookId,
    issueId,
    "id",
  ).maybeSingle();
  if (lookupErr) {
    return { ok: false, error: lookupErr.message };
  }
  if (existing) {
    return {
      ok: false,
      error: `${issueId} already exists in ${args.bookId}.`,
    };
  }
  const { data, error } = (await insertIssue(supabaseAdmin, {
    id: issueId,
    book_id: args.bookId,
    number: args.issueNumber,
    name: `Issue ${args.issueNumber}`,
    wiki_url: args.wikiUrl,
    source_url: args.sourceUrl,
  })
    .select("id")
    .single()) as {
    data: { id: string } | null;
    error: { message: string } | null;
  };

  if (error || !data) {
    return { ok: false, error: error?.message ?? "Insert failed" };
  }

  return { ok: true, data: { id: data.id } };
}

// ─── confirmSource ───────────────────────────────────────────────────────────

/**
 * Confirm: save the checked URL as the issue's `source_url`, creating the row
 * when it does not exist yet. The downloader reads the URL from that row. An
 * issue that already has pages is refused, so a confirm never leads to a
 * download over stored pages.
 */
export async function confirmSource(
  args: CreateIssueArgs,
): Promise<Result<{ id: string }>> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const issueId = `issue-${args.issueNumber}`;
  const { data: existing, error: lookupErr } = (await selectIssue(
    supabaseAdmin,
    args.bookId,
    issueId,
    "id, page_count",
  ).maybeSingle()) as {
    data: { id: string; page_count: number | null } | null;
    error: { message: string } | null;
  };
  if (lookupErr) return { ok: false, error: lookupErr.message };
  if (!existing) return createIssue(args);
  if ((existing.page_count ?? 0) > 0) {
    return {
      ok: false,
      error: `${issueId} already has ${existing.page_count} pages in ${args.bookId}.`,
    };
  }
  const { error } = await updateIssue(supabaseAdmin, args.bookId, issueId, {
    source_url: args.sourceUrl,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, data: { id: issueId } };
}

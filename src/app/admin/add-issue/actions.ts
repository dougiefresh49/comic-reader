"use server";

import { supabaseAdmin } from "~/lib/supabase-admin";
import { GEMINI_MEDIUM } from "~/lib/models";
import { GoogleGenAI, createPartFromText } from "@google/genai";

type Ok<T> = { ok: true; data: T };
type Err = { ok: false; error: string };
type Result<T> = Ok<T> | Err;

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

// ─── getBookInfo ─────────────────────────────────────────────────────────────

interface BookInfo {
  name: string;
  totalIssues: number | null;
  wikiHost: string | null;
  wikiTitleTemplate: string | null;
  parts: { id: string; number: number; name: string; slug: string }[];
  nextIssueNumber: number;
}

export async function getBookInfo(bookId: string): Promise<Result<BookInfo>> {
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

  const { data: parts } = (await supabaseAdmin
    .from("book_parts")
    .select("id, number, name, slug")
    .eq("book_id", bookId)
    .order("number", { ascending: true })) as {
    data: { id: string; number: number; name: string; slug: string }[] | null;
  };

  const { data: maxIssue } = (await supabaseAdmin
    .from("issues")
    .select("number")
    .eq("book_id", bookId)
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
      parts: parts ?? [],
      nextIssueNumber: (maxIssue?.number ?? 0) + 1,
    },
  };
}

// ─── lookupNextIssue ─────────────────────────────────────────────────────────

interface NextIssueInfo {
  nextNumber: number;
  suggestedWikiUrl: string | null;
}

export async function lookupNextIssue(
  bookId: string,
  partId?: string,
): Promise<Result<NextIssueInfo>> {
  let query = supabaseAdmin
    .from("issues")
    .select("number")
    .eq("book_id", bookId)
    .order("number", { ascending: false })
    .limit(1);

  if (partId) {
    query = query.eq("part_id", partId);
  }

  const { data: maxIssue } = (await query.single()) as {
    data: { number: number } | null;
  };
  const nextNumber = (maxIssue?.number ?? 0) + 1;

  const { data: book } = (await supabaseAdmin
    .from("books")
    .select("wiki_host, wiki_title_template")
    .eq("id", bookId)
    .single()) as {
    data: {
      wiki_host: string | null;
      wiki_title_template: string | null;
    } | null;
  };

  let suggestedWikiUrl: string | null = null;
  if (book?.wiki_host && book?.wiki_title_template) {
    const title = book.wiki_title_template.replace(
      "{number}",
      String(nextNumber),
    );
    const host = book.wiki_host.startsWith("http")
      ? book.wiki_host
      : `https://${book.wiki_host}`;
    suggestedWikiUrl = `${host}/wiki/${title}`;
  }

  return { ok: true, data: { nextNumber, suggestedWikiUrl } };
}

// ─── findReadingSource ───────────────────────────────────────────────────────

interface ReadingSource {
  url: string;
  siteName: string;
  confidence: "high" | "medium" | "low";
}

export async function findReadingSource(
  bookTitle: string,
  issueNumber: number,
): Promise<Result<ReadingSource>> {
  const prompt = `Find a URL where I can read "${bookTitle}" issue #${issueNumber} online for free. Return ONLY a JSON object with these fields: { "url": string, "siteName": string, "confidence": "high" | "medium" | "low" }. No explanation, no markdown fences.`;

  try {
    const response = await ai.models.generateContent({
      model: GEMINI_MEDIUM,
      contents: [createPartFromText(prompt)],
      config: {
        tools: [{ googleSearch: {} }],
      },
    });

    const text = response.text?.trim();
    if (!text) {
      return { ok: false, error: "Gemini returned empty response" };
    }

    // Strip markdown fences if Gemini ignores instruction
    const cleaned = text.replace(/^```json?\n?/i, "").replace(/\n?```$/i, "");
    const parsed = JSON.parse(cleaned) as ReadingSource;

    if (!parsed.url || !parsed.siteName) {
      return { ok: false, error: "Gemini response missing required fields" };
    }

    return { ok: true, data: parsed };
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
  partId?: string;
  wikiUrl: string;
  sourceUrl: string;
}

export async function createIssue(
  args: CreateIssueArgs,
): Promise<Result<{ id: string }>> {
  const issueId = `issue-${args.issueNumber}`;
  const { data, error } = (await supabaseAdmin
    .from("issues")
    .insert({
      id: issueId,
      book_id: args.bookId,
      number: args.issueNumber,
      name: `Issue ${args.issueNumber}`,
      part_id: args.partId ?? null,
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

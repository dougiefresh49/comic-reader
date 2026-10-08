"use server";

import { supabaseAdmin } from "~/lib/supabase-admin";
import { GEMINI_MEDIUM } from "~/lib/models";
import { createPartFromText } from "@google/genai";
import { getGeminiClient } from "~/lib/gemini-client";
import { generateContentLogged } from "~/lib/llm-usage";
import { insertIssue, listBookIssues, selectIssue } from "~/lib/issue-queries";
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
      { step: "admin:add-issue:find-source" },
    );

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

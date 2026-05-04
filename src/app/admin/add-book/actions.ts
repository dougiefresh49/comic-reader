"use server";

import { GoogleGenAI, createPartFromText } from "@google/genai";
import { GEMINI_MEDIUM } from "~/lib/models";
import { supabaseAdmin } from "~/lib/supabase-admin";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

type Ok<T> = { ok: true; data: T };
type Err = { ok: false; error: string };
type Result<T> = Ok<T> | Err;

export interface BookSearchResult {
  title: string;
  wikiUrl: string;
  wikiHost: string;
  publisher: string;
  franchises: string[];
  hasParts: boolean;
  parts:
    | { name: string; number: number; issueCount: number; wikiUrl: string }[]
    | null;
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
- hasParts: boolean — true if the series is divided into named parts/volumes (e.g., "Part I", "Part II")
- parts: if hasParts is true, array of { name, number, issueCount, wikiUrl } for each part. Otherwise null.
- totalIssues: total number of issues across all parts (or in the series if no parts)
- wikiTitleTemplate: the URL path pattern for individual issues, with {number} as placeholder

Return JSON only, no markdown.`;

  try {
    const response = await ai.models.generateContent({
      model: GEMINI_MEDIUM,
      contents: [createPartFromText(prompt)],
      config: {
        tools: [{ googleSearch: {} }],
      },
    });

    const text = response.text?.trim();
    if (!text) return { ok: false, error: "Empty response from Gemini" };

    const cleaned = text.replace(/^```json?\s*/, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(cleaned) as Omit<
      BookSearchResult,
      "suggestedSlug"
    >;

    return {
      ok: true,
      data: { ...parsed, suggestedSlug: generateSlug(parsed.title) },
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
  parts?: {
    name: string;
    number: number;
    issueCount: number;
    wikiUrl: string;
  }[];
}

export async function createBook(
  args: CreateBookArgs,
): Promise<Result<{ id: string }>> {
  const {
    slug,
    title,
    wikiHost,
    wikiTitleTemplate,
    publisher,
    franchises,
    totalIssues,
    parts,
  } = args;

  if (!slug || !title)
    return { ok: false, error: "Slug and title are required" };

  const { error: bookError } = await supabaseAdmin.from("books").insert({
    id: slug,
    name: title,
    wiki_host: wikiHost,
    wiki_title_template: wikiTitleTemplate,
    publisher,
    franchises,
    total_issues: totalIssues,
  });

  if (bookError) return { ok: false, error: bookError.message };

  if (parts?.length) {
    const partRows = parts.map((p) => ({
      id: `${slug}-part-${p.number}`,
      book_id: slug,
      number: p.number,
      name: p.name,
      slug: `part-${p.number}`,
      wiki_url: p.wikiUrl,
      total_issues: p.issueCount,
    }));

    const { error: partsError } = await supabaseAdmin
      .from("book_parts")
      .insert(partRows);

    if (partsError) return { ok: false, error: partsError.message };
  }

  return { ok: true, data: { id: slug } };
}

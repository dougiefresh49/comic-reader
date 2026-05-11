import type { SupabaseClient } from "@supabase/supabase-js";

export interface WikiSection {
  toclevel: number;
  level: string;
  line: string;
  number: string;
  index: string;
}

interface WikiParseResponse {
  parse?: {
    title: string;
    sections: WikiSection[];
    text?: { "*": string };
  };
  error?: { code: string; info: string };
}

export interface AppearanceEntry {
  name: string;
  qualifier?: string;
}

export interface WikiContext {
  summary: string | null;
  appearances: AppearanceEntry[] | null;
}

export async function fetchWikiSections(
  wikiHost: string,
  pageTitle: string,
): Promise<{ sections: WikiSection[]; title: string } | null> {
  const url = `https://${wikiHost}/api.php?action=parse&page=${encodeURIComponent(pageTitle)}&format=json&prop=sections`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(
      `  [wiki] HTTP ${res.status} fetching sections for "${pageTitle}"`,
    );
    return null;
  }
  const data = (await res.json()) as WikiParseResponse;
  if (data.error) {
    console.warn(`  [wiki] API error: ${data.error.info}`);
    return null;
  }
  if (!data.parse) return null;
  return { sections: data.parse.sections, title: data.parse.title };
}

async function fetchSectionHtml(
  wikiHost: string,
  pageTitle: string,
  sectionIndex: string,
): Promise<string> {
  const url = `https://${wikiHost}/api.php?action=parse&page=${encodeURIComponent(pageTitle)}&format=json&prop=text&section=${sectionIndex}`;
  const res = await fetch(url);
  if (!res.ok) return "";
  const data = (await res.json()) as WikiParseResponse;
  return data.parse?.text?.["*"] ?? "";
}

async function fetchSectionText(
  wikiHost: string,
  pageTitle: string,
  sectionIndex: string,
): Promise<string> {
  const html = await fetchSectionHtml(wikiHost, pageTitle, sectionIndex);
  return stripHtml(html).trim();
}

export function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<sup[^>]*>[\s\S]*?<\/sup>/gi, "")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseAppearancesFromHtml(html: string): AppearanceEntry[] {
  const entries: AppearanceEntry[] = [];

  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowHtml = rowMatch[1] ?? "";
    const cells = rowHtml.match(/<td[^>]*>([\s\S]*?)<\/td>/gi);
    if (!cells) continue;
    const texts = cells.map((c) => stripHtml(c).trim()).filter(Boolean);
    if (texts.length >= 2) {
      entries.push({ name: texts[1]!, qualifier: texts[0] });
    } else if (texts.length === 1) {
      entries.push({ name: texts[0]! });
    }
  }

  if (entries.length === 0) {
    const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let liMatch;
    while ((liMatch = liRegex.exec(html)) !== null) {
      const text = stripHtml(liMatch[1] ?? "").trim();
      if (!text) continue;
      if (/^(appearances|appearing|characters|cast|location)/i.test(text))
        continue;
      const parenMatch = /^(.+?)\s*\((.+?)\)\s*$/.exec(text);
      if (parenMatch?.[1] && parenMatch[2]) {
        entries.push({
          name: parenMatch[1].trim(),
          qualifier: parenMatch[2].trim(),
        });
      } else {
        entries.push({ name: text });
      }
    }
  }

  return entries;
}

export async function fetchWikiContext(
  wikiHost: string,
  pageTitle: string,
): Promise<WikiContext> {
  console.log(`  [wiki] Fetching: ${pageTitle}`);
  const result = await fetchWikiSections(wikiHost, pageTitle);
  if (!result) return { summary: null, appearances: null };

  const { sections } = result;

  const summarySection = sections.find((s) =>
    /^(synopsis|summary|plot)/i.test(s.line),
  );
  const appearancesSection = sections.find((s) =>
    /^(appearing|appearances|characters|cast)/i.test(s.line),
  );

  let summary: string | null = null;
  if (summarySection) {
    summary = await fetchSectionText(wikiHost, pageTitle, summarySection.index);
    if (summary) {
      console.log(`  [wiki] Summary: ${summary.length} chars`);
    }
  }

  let appearances: AppearanceEntry[] | null = null;
  if (appearancesSection) {
    const parentLevel = parseInt(appearancesSection.level, 10);
    const parentIdx = sections.indexOf(appearancesSection);
    const childSections = sections.filter(
      (s, i) => i > parentIdx && parseInt(s.level, 10) > parentLevel,
    );
    const nextSibling = sections.find(
      (s, i) => i > parentIdx && parseInt(s.level, 10) <= parentLevel,
    );
    const relevantChildren = nextSibling
      ? childSections.filter(
          (s) => sections.indexOf(s) < sections.indexOf(nextSibling),
        )
      : childSections;

    const allNames: AppearanceEntry[] = [];
    for (const child of relevantChildren) {
      if (/location/i.test(child.line)) continue;
      const html = await fetchSectionHtml(wikiHost, pageTitle, child.index);
      if (html) {
        const entries = parseAppearancesFromHtml(html);
        for (const e of entries) {
          if (!allNames.some((a) => a.name === e.name)) {
            allNames.push(e);
          }
        }
      }
    }
    if (allNames.length > 0) {
      appearances = allNames;
      console.log(`  [wiki] Appearances: ${appearances.length} characters`);
    }
  }

  return { summary, appearances };
}

export async function fetchAndStoreWikiContext(
  supabase: SupabaseClient,
  bookId: string,
  issueId: string,
): Promise<WikiContext> {
  const { data: book } = await supabase
    .from("books")
    .select("wiki_host, wiki_title_template")
    .eq("id", bookId)
    .single();

  if (!book?.wiki_host || !book?.wiki_title_template) {
    console.log(`[wiki] ${bookId}: no wiki config — skip`);
    return { summary: null, appearances: null };
  }

  const { data: issue } = await supabase
    .from("issues")
    .select("number, wiki_summary")
    .eq("book_id", bookId)
    .eq("id", issueId)
    .single();

  if (!issue) {
    console.log(`[wiki] ${bookId}/${issueId}: issue not found — skip`);
    return { summary: null, appearances: null };
  }

  if (issue.wiki_summary) {
    console.log(`[wiki] ${bookId}/${issueId}: already has wiki data — skip`);
    return { summary: issue.wiki_summary as string, appearances: null };
  }

  const pageTitle = (book.wiki_title_template as string).replace(
    "{number}",
    String(issue.number),
  );
  const context = await fetchWikiContext(book.wiki_host as string, pageTitle);

  if (!context.summary && !context.appearances) {
    console.log(`[wiki] ${bookId}/${issueId}: no wiki data found`);
    return context;
  }

  const { error } = await supabase
    .from("issues")
    .update({
      wiki_summary: context.summary,
      wiki_appearances: context.appearances,
    })
    .eq("id", issueId)
    .eq("book_id", bookId);

  if (error) {
    console.warn(
      `[wiki] ${bookId}/${issueId}: DB update failed: ${error.message}`,
    );
  } else {
    console.log(`[wiki] ${bookId}/${issueId}: saved to DB`);
  }

  return context;
}

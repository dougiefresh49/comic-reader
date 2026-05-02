#!/usr/bin/env node

/**
 * Step 3.5 — Fetch wiki context (Summary + Appearances) from a fandom wiki
 * via the MediaWiki API and persist to the issues table.
 *
 * Usage:
 *   pnpm fetch-wiki-context -- --book tmnt-mmpr-iii --issue 1
 *   pnpm fetch-wiki-context -- --book tmnt-mmpr-iii --all
 *   pnpm fetch-wiki-context -- --book tmnt-mmpr-iii --issue 1 --force
 */

import { supabase } from "./lib/supabase.js";

interface Args {
  book: string;
  issue?: number;
  all: boolean;
  force: boolean;
}

interface WikiSection {
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

interface AppearanceEntry {
  name: string;
  qualifier?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`
Usage:
  pnpm fetch-wiki-context -- --book <id> --issue <number>
  pnpm fetch-wiki-context -- --book <id> --all
  pnpm fetch-wiki-context -- --book <id> --issue <number> --force

Options:
  --book    Book ID (required)
  --issue   Issue number (fetch one issue)
  --all     Fetch all issues for the book
  --force   Overwrite existing wiki data
`);
    process.exit(0);
  }

  let book = "";
  let issue: number | undefined;
  let all = false;
  let force = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--all") {
      all = true;
      continue;
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--book" || arg?.startsWith("--book=")) {
      book = (arg.includes("=") ? arg.split("=")[1] : argv[++i]) ?? "";
    } else if (arg === "--issue" || arg?.startsWith("--issue=")) {
      issue = parseInt(
        (arg.includes("=") ? arg.split("=")[1] : argv[++i]) ?? "0",
        10,
      );
    }
  }

  if (!book) {
    console.error("❌ --book is required");
    process.exit(1);
  }
  if (!all && issue === undefined) {
    console.error("❌ Provide --issue <number> or --all");
    process.exit(1);
  }

  return { book, issue, all, force };
}

async function fetchWikiSections(
  wikiHost: string,
  pageTitle: string,
): Promise<{ sections: WikiSection[]; title: string } | null> {
  const url = `https://${wikiHost}/api.php?action=parse&page=${encodeURIComponent(pageTitle)}&format=json&prop=sections`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(
      `  ⚠️  HTTP ${res.status} fetching sections for "${pageTitle}"`,
    );
    return null;
  }
  const data = (await res.json()) as WikiParseResponse;
  if (data.error) {
    console.warn(`  ⚠️  Wiki API error: ${data.error.info}`);
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

function stripHtml(html: string): string {
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

function parseAppearancesFromHtml(html: string): AppearanceEntry[] {
  const entries: AppearanceEntry[] = [];

  // Try table rows first (Power Rangers wiki uses tables)
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

  // Fall back to list items if no table rows found
  if (entries.length === 0) {
    const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let liMatch;
    while ((liMatch = liRegex.exec(html)) !== null) {
      const text = stripHtml(liMatch[1] ?? "").trim();
      if (!text) continue;
      if (/^(appearances|appearing|characters|cast|location)/i.test(text))
        continue;
      const parenMatch = text.match(/^(.+?)\s*\((.+?)\)\s*$/);
      if (parenMatch && parenMatch[1] && parenMatch[2]) {
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

async function fetchWikiContext(
  wikiHost: string,
  pageTitle: string,
): Promise<{ summary: string | null; appearances: AppearanceEntry[] | null }> {
  console.log(`  🌐 Fetching wiki: ${pageTitle}`);
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
      console.log(`  ✓ Summary: ${summary.length} chars`);
    }
  } else {
    console.log(`  ⚠️  No Summary/Synopsis section found`);
  }

  let appearances: AppearanceEntry[] | null = null;
  if (appearancesSection) {
    const parentLevel = parseInt(appearancesSection.level, 10);
    const parentIdx = sections.indexOf(appearancesSection);
    const childSections = sections.filter(
      (s, i) => i > parentIdx && parseInt(s.level, 10) > parentLevel,
    );
    // Stop at next sibling section
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
      console.log(`  ✓ Appearances: ${appearances.length} characters`);
    }
  } else {
    console.log(`  ⚠️  No Appearances section found`);
  }

  return { summary, appearances };
}

async function main() {
  const args = parseArgs();

  const { data: book, error: bookErr } = await supabase
    .from("books")
    .select("id, name, wiki_host, wiki_title_template")
    .eq("id", args.book)
    .single();

  if (bookErr || !book) {
    console.error(`❌ Book "${args.book}" not found`);
    process.exit(1);
  }

  if (!book.wiki_host || !book.wiki_title_template) {
    console.error(
      `❌ Book "${book.name}" has no wiki config (wiki_host / wiki_title_template)`,
    );
    process.exit(1);
  }

  console.log(`📚 ${book.name}`);
  console.log(`   Wiki: ${book.wiki_host} / ${book.wiki_title_template}\n`);

  let query = supabase
    .from("issues")
    .select("id, book_id, number, name, wiki_summary")
    .eq("book_id", args.book)
    .order("number");

  if (!args.all && args.issue !== undefined) {
    query = query.eq("number", args.issue);
  }

  const { data: issues, error: issuesErr } = await query;
  if (issuesErr || !issues?.length) {
    console.error(`❌ No issues found`);
    process.exit(1);
  }

  let fetched = 0;
  let skipped = 0;

  for (const issue of issues) {
    console.log(`\n── ${issue.name} ──`);

    if (issue.wiki_summary && !args.force) {
      console.log(`  ⏭️  Already has wiki data (use --force to overwrite)`);
      skipped++;
      continue;
    }

    const pageTitle = book.wiki_title_template.replace(
      "{number}",
      String(issue.number),
    );
    const { summary, appearances } = await fetchWikiContext(
      book.wiki_host,
      pageTitle,
    );

    if (!summary && !appearances) {
      console.log(`  ⚠️  No wiki data found — skipping DB update`);
      continue;
    }

    const { error: updateErr } = await supabase
      .from("issues")
      .update({
        wiki_summary: summary,
        wiki_appearances: appearances,
      })
      .eq("id", issue.id)
      .eq("book_id", issue.book_id);

    if (updateErr) {
      console.error(`  ❌ DB update failed: ${updateErr.message}`);
    } else {
      console.log(`  💾 Saved to DB`);
      fetched++;
    }
  }

  console.log(`\n✅ Done — fetched: ${fetched}, skipped: ${skipped}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

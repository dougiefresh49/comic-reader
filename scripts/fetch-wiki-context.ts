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
import { fetchWikiContext } from "~/lib/wiki-fetch.js";

interface Args {
  book: string;
  issue?: number;
  all: boolean;
  force: boolean;
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

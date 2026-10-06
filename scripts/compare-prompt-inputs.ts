#!/usr/bin/env node

/**
 * SELECT-only evidence for #463 (P4): for every page of one issue, prints
 * the prompt inputs that read aliases and franchises, as the steps build
 * them:
 *
 * - the closed-cast lines get-context sends, as `closedCastLines` writes
 *   them with the seen note off, each after its character id;
 * - the book context get-context sends, which holds the "Franchises:" line;
 * - the face step's known-character list (`buildKnownCharacterListOrFatal`).
 *
 * Stops where the prompts would be sent: no Gemini call, no write. The gate
 * runs it before and after the change and diffs the two outputs.
 *
 * Usage: pnpm exec tsx --conditions=react-server --env-file=.env scripts/compare-prompt-inputs.ts [--book <id>] [--issue <id>]
 */

import { createTypedStepClient } from "~/workflows/step-utils";
import {
  buildKnownCharacterListOrFatal,
  contextPromptInputs,
} from "~/workflows/steps/vision";
import { closedCastLines } from "~/workflows/steps/vision-rows";

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

const bookId = flag("--book", "tmnt-mmpr-iii");
const issueId = flag("--issue", "issue-1");

const supabase = await createTypedStepClient();

const { data: pages, error } = await supabase
  .from("pages")
  .select("number")
  .eq("book_id", bookId)
  .eq("issue_id", issueId)
  .order("number");
if (error) throw new Error(`reading pages: ${error.message}`);
if (!pages?.length) throw new Error(`no pages for ${bookId}/${issueId}`);

for (const { number } of pages) {
  const pageLabel = `page-${String(number).padStart(2, "0")}`;
  const { bookContext, cast } = await contextPromptInputs(
    supabase,
    bookId,
    issueId,
    pageLabel,
  );
  const lines = closedCastLines(cast, []);
  const known = await buildKnownCharacterListOrFatal(
    supabase,
    bookId,
    pageLabel,
  );

  console.log(`== ${bookId}/${issueId} ${pageLabel}`);
  console.log("-- closed cast");
  cast.forEach((m, i) => console.log(`${m.id}\t${lines[i]}`));
  console.log("-- book context");
  console.log(bookContext ?? "(none)");
  console.log("-- known characters (face step)");
  for (const name of known) console.log(name);
}

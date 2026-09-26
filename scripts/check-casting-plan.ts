#!/usr/bin/env node
/**
 * Read-only casting plan for an issue. SELECTs only.
 *
 *   pnpm exec tsx --env-file=.env scripts/check-casting-plan.ts --book <b> --issue <i>
 */

import { supabase } from "./lib/supabase.js";
import { planCastingTasks } from "~/workflows/steps/casting-tasks";

function parseArgs(): { book: string; issue: string } {
  const args = process.argv.slice(2);
  let book = "";
  let issue = "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg.startsWith("--book=")) {
      book = arg.split("=")[1]?.trim() ?? "";
    } else if (arg === "--book") {
      book = args[i + 1]?.trim() ?? "";
    } else if (arg.startsWith("--issue=")) {
      const raw = arg.split("=")[1]?.trim() ?? "";
      issue = raw.startsWith("issue-") ? raw : `issue-${raw}`;
    } else if (arg === "--issue") {
      const raw = args[i + 1]?.trim() ?? "";
      issue = raw.startsWith("issue-") ? raw : `issue-${raw}`;
    }
  }

  if (!book || !issue) {
    console.error("Usage: check-casting-plan.ts --book <b> --issue <i>");
    process.exit(1);
  }

  return { book, issue };
}

async function main() {
  const { book, issue } = parseArgs();
  const plan = await planCastingTasks(supabase, book, issue);
  const wouldCreate = plan.toCreate.length;
  const pending = wouldCreate + plan.existingPending;
  const casting = pending === 0 ? "skip" : "pause";

  console.log(
    `speakers=${plan.speakers} cast=${plan.cast} unresolved=${plan.unresolved.length} would_create=${wouldCreate} casting=${casting}`,
  );

  if (plan.unresolved.length > 0) {
    console.log(`unresolved_speakers=${plan.unresolved.join(",")}`);
  }
  if (wouldCreate > 0) {
    console.log(`would_create_ids=${plan.toCreate.join(",")}`);
  }
  if (plan.toCopy.length > 0) {
    console.log(`would_copy=${plan.toCopy.map((r) => r.character).join(",")}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

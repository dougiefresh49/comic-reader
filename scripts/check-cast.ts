#!/usr/bin/env node
/**
 * Evidence for #347: prints `proposeCast` for three issues and `getCast` for
 * one. SELECTs only; it calls none of the writers in src/lib/cast.ts.
 *
 *   pnpm exec tsx --env-file=.env scripts/check-cast.ts
 */
import { supabase } from "./lib/supabase.js";
import { getCast, proposeCast, type CastProposal } from "~/lib/cast";

const ISSUES = [
  ["tmnt-mmpr-iii", "issue-3"],
  ["tmnt-mmpr-iii", "issue-1"],
  ["smoke-test", "issue-smoke"],
] as const;

function print(bookId: string, issueId: string, p: CastProposal): void {
  console.log(`\n== proposeCast('${bookId}', '${issueId}')`);
  console.log(`members (${p.members.length}):`);
  for (const m of p.members) {
    const why = m.sources.map((s) => {
      if (s === "faces") return `faces x${m.faces}`;
      if (s === "wiki") return `wiki [${m.wikiNames.join("; ")}]`;
      if (s === "cast before") return `cast before [${m.castNames.join("; ")}]`;
      return s;
    });
    console.log(`  ${m.id.padEnd(24)} ${m.name.padEnd(24)} ${why.join(", ")}`);
  }
  console.log(`suggestions, no characters row (${p.suggestions.length}):`);
  for (const s of p.suggestions) {
    const q = s.qualifier ? ` (${s.qualifier})` : "";
    console.log(`  ${s.source.padEnd(12)} ${s.name}${q}`);
  }
}

async function main(): Promise<void> {
  for (const [bookId, issueId] of ISSUES) {
    const proposal = await proposeCast(supabase, bookId, issueId);
    print(bookId, issueId, proposal);
    if (bookId === "smoke-test") {
      for (const id of ["alpha-5", "michelangelo"]) {
        const m = proposal.members.find((x) => x.id === id);
        console.log(
          m
            ? `${id}: a member, from ${m.sources.join(", ")}`
            : `${id}: not a member`,
        );
      }
    }
  }

  console.log(`\n== getCast('tmnt-mmpr-iii', 'issue-1')`);
  for (const e of await getCast(supabase, "tmnt-mmpr-iii", "issue-1")) {
    const v = e.voice
      ? `${e.voice.voiceUuid ?? "-"} via ${e.voice.from}`
      : "no voice";
    console.log(
      `  ${e.displayName.padEnd(18)} id=${e.characterId ?? "null"}  ${v}`,
    );
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

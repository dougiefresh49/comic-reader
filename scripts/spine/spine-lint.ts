#!/usr/bin/env node
// copied from fleet scripts/ @ 1b11db7
/**
 * spine-lint: the one-`state/*`-per-issue invariant (room-of-devs #75;
 * fleet #79 made it the fleet default).
 *
 * Every open issue carries exactly one label from the state/* set, and a
 * `state/working` issue has a structured claim comment from a trusted
 * login (#83): claim-at-start writes `claimed by session <sid>, doing
 * <what>` before the first edit. Anything that reads the spine (a tap-in
 * digest, a wave report) trusts the labels and the claim, so a mislabelled
 * ticket or a spoofable claim is an accuracy bug, not tidiness.
 *
 * Run from the repo to lint (gh infers the repo from the cwd), or point
 * it elsewhere with GH_REPO=owner/name:
 *
 *   node <fleet>/scripts/spine-lint.ts          # node 22.18+, no install
 *   npx tsx <fleet>/scripts/spine-lint.ts       # older node
 *   GH_REPO=dougiefresh49/voice-lab node <fleet>/scripts/spine-lint.ts
 *
 * Read-only: two gh calls (issue list, repo owner), no LLM. Checks the
 * first 1000 open issues. It proves the labels and the claim text, not
 * that the claimant is still live or that the claim preceded the first
 * edit; those are the corefile rule's job.
 */
import { spawnSync } from "node:child_process";
import { parseClaim, STATE_LABELS, trustedLogins } from "./spine-claim.ts";

type Issue = {
  number: number;
  title: string;
  labels: { name: string }[];
  comments: { author?: { login?: string }; body: string }[];
};

const r = spawnSync(
  "gh",
  [
    "issue",
    "list",
    "--state",
    "open",
    "--limit",
    "1000",
    "--json",
    "number,title,labels,comments",
  ],
  { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 },
);
if (r.status !== 0) {
  console.error(`[spine-lint] gh issue list failed: ${r.stderr?.trim()}`);
  process.exit(1);
}
const issues = JSON.parse(r.stdout) as Issue[];

const trusted = trustedLogins();
if (trusted.size === 0) {
  console.error(
    "[spine-lint] could not resolve the repo owner (gh repo view failed); cannot validate claims",
  );
  process.exit(1);
}

const known = new Set<string>(STATE_LABELS);
const failures: string[] = [];
for (const i of issues) {
  const states = i.labels
    .filter((l) => l.name.startsWith("state/"))
    .map((l) => l.name);
  const unknown = states.filter((s) => !known.has(s));
  if (states.length !== 1) {
    failures.push(
      `#${i.number} has ${states.length} state/* labels (${states.join(", ") || "none"}): ${i.title}`,
    );
  } else if (unknown.length) {
    failures.push(
      `#${i.number} carries ${unknown[0]}, not in the state/* set (${STATE_LABELS.join(", ")}): ${i.title}`,
    );
  } else if (states[0] === "state/working") {
    const claim = i.comments.find(
      (c) => trusted.has(c.author?.login ?? "") && parseClaim(c.body) !== null,
    );
    if (!claim) {
      const why = i.comments.some((c) => parseClaim(c.body) !== null)
        ? `only untrusted authors wrote one (trusted: ${[...trusted].join(", ")})`
        : `expected 'claimed by session <sid>, doing <what>' from ${[...trusted].join(" or ")}`;
      failures.push(
        `#${i.number} is state/working with no structured claim comment (${why}): ${i.title}`,
      );
    }
  }
}

if (failures.length) {
  console.error(
    `[spine-lint] ${failures.length} violation(s) of the spine invariants (#75, #83):`,
  );
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `[spine-lint] OK: ${issues.length} open issue(s), one state/* label each, structured claims on state/working`,
);

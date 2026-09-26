// copied from fleet scripts/ @ 1b11db7
/**
 * spine-claim: the structured claim marker (room-of-devs #83, follow-up
 * to #75; fleet #79 made it the fleet default).
 *
 * A claim comment carries a line of the form
 *
 *   claimed by session <sid>[ / <Persona>], doing <what>
 *
 * where <sid> is the thread's session id prefix: the first 8+ hex chars
 * of the transcript filename or session uuid, the worktree/branch hash
 * for a T3 Code session, or the lane's branch-name hash for a delegate
 * lane (orchestrate-backlog skill). The sid is the join key between a
 * digest's IN FLIGHT list (claimed tickets) and its LIVE THREADS list
 * (transcript activity); the persona is optional decoration for the
 * owner's eyes.
 *
 * Trust: on a public repo anyone can comment, and a digest treats claims
 * as authoritative, so a claim only counts when its author is the repo
 * owner or a designated bot login (comma-separated SPINE_CLAIM_BOTS env).
 * On an org-owned repo the owner login is the org, which no human
 * comments as: set SPINE_CLAIM_BOTS to the logins that may claim.
 *
 * Shared by spine-lint.ts (enforcement) and any digest that joins live
 * threads to tickets (room-of-devs tap-in.ts is the first). Runs under
 * node 22.18+ (native type stripping) or `npx tsx`; no other deps.
 */
import { spawnSync } from "node:child_process";

/**
 * First 8 chars must be hex (a session id prefix); dashes allowed after
 * (uuid). One line: only horizontal whitespace between the parts, so a
 * marker that wraps onto a second line is not a claim.
 */
export const CLAIM_RE =
  /^claimed by session ([0-9a-f]{8}[0-9a-f-]*)(?:[ \t]*\/[ \t]*([^,\r\n\u2028\u2029]+?))?,[ \t]*doing[ \t]+(\S.*)$/im;

/** The full state/* vocabulary; exactly one per open issue (spine-lint). */
export const STATE_LABELS = [
  "state/open",
  "state/plan-review",
  "state/working",
  "state/blocked",
  "state/needs-feedback",
  "state/verify",
  "state/settled",
] as const;

export type Claim = { session: string; persona?: string; doing: string };

export function parseClaim(body: string): Claim | null {
  const m = CLAIM_RE.exec(body);
  if (!m) return null;
  return { session: m[1], persona: m[2]?.trim(), doing: m[3].trim() };
}

/** Two session ids refer to the same thread when their 8-char prefixes agree. */
export function sameSession(a: string, b: string): boolean {
  return a.slice(0, 8) === b.slice(0, 8);
}

/**
 * Logins whose claim comments are authoritative: the repo owner (resolved
 * live through gh, so a fork lints against its own owner; GH_REPO in the
 * environment redirects it) plus SPINE_CLAIM_BOTS.
 */
export function trustedLogins(cwd?: string): Set<string> {
  const bots = (process.env.SPINE_CLAIM_BOTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const r = spawnSync(
    "gh",
    ["repo", "view", "--json", "owner", "--jq", ".owner.login"],
    {
      cwd,
      encoding: "utf-8",
    },
  );
  const owner = r.status === 0 ? r.stdout.trim() : "";
  return new Set([owner, ...bots].filter(Boolean));
}

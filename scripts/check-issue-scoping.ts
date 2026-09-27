#!/usr/bin/env node
/**
 * check-issue-scoping: flag queries that filter an issue without book_id.
 *
 * `issues` has PK (book_id, id), and issue ids repeat across books. A chain
 * that filters only by id (or a child table that filters only by issue_id)
 * can hit the wrong book once a second issue-1 lands.
 *
 * Run: pnpm tsx scripts/check-issue-scoping.ts
 *
 * No env, no network. Exit 1 when anything is reported, 0 otherwise.
 * Stdout is one path:line per finding, sorted by path then line.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SELF = "scripts/check-issue-scoping.ts";

const FROM_RE = /\.from\(\s*(["'])([^"']+)\1\s*\)/g;
const EQ_ID_RE = /\.eq\(\s*(["'])id\1\s*,/g;
const EQ_ISSUE_ID_RE = /\.eq\(\s*(["'])issue_id\1\s*,/g;
const BOOK_ID_RE = /["']book_id["']/;

function listedFiles(): string[] {
  // Filter git ls-files output rather than pathspecs: git's `**` does not
  // match zero directories, so `scripts/**/*.ts` misses top-level scripts/*.ts.
  const out = execFileSync("git", ["ls-files"], { encoding: "utf-8" });
  return out
    .split("\n")
    .map((p) => p.trim())
    .filter((p) => {
      if (p.length === 0 || p === SELF) return false;
      if (!p.startsWith("src/") && !p.startsWith("scripts/")) return false;
      return p.endsWith(".ts") || p.endsWith(".tsx");
    });
}

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

function statementEnd(source: string, fromIndex: number): number {
  const semi = source.indexOf(";", fromIndex);
  return semi === -1 ? source.length : semi;
}

function collectEqLines(
  source: string,
  statementStart: number,
  statement: string,
  re: RegExp,
): number[] {
  const lines: number[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(statement)) !== null) {
    lines.push(lineAt(source, statementStart + m.index));
  }
  return lines;
}

function scanFile(path: string): string[] {
  const source = readFileSync(path, "utf-8");
  const findings: string[] = [];
  FROM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FROM_RE.exec(source)) !== null) {
    const table = m[2]!;
    const start = m.index;
    const end = statementEnd(source, start);
    const statement = source.slice(start, end);
    if (BOOK_ID_RE.test(statement)) continue;

    if (table === "issues") {
      for (const line of collectEqLines(source, start, statement, EQ_ID_RE)) {
        findings.push(`${path}:${line}`);
      }
    } else {
      for (const line of collectEqLines(
        source,
        start,
        statement,
        EQ_ISSUE_ID_RE,
      )) {
        findings.push(`${path}:${line}`);
      }
    }
  }
  return findings;
}

function main(): void {
  const findings: string[] = [];
  for (const path of listedFiles()) {
    findings.push(...scanFile(path));
  }
  findings.sort((a, b) => {
    const [ap, al] = a.split(":") as [string, string];
    const [bp, bl] = b.split(":") as [string, string];
    if (ap !== bp) return ap < bp ? -1 : 1;
    return Number(al) - Number(bl);
  });
  // Unique: one path:line per line even if two from-chains overlap.
  const seen = new Set<string>();
  for (const f of findings) {
    if (seen.has(f)) continue;
    seen.add(f);
    console.log(f);
  }
  process.exit(seen.size > 0 ? 1 : 0);
}

main();

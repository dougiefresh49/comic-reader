#!/usr/bin/env node
/**
 * check-issue-scoping: flag queries that filter an issue without book_id.
 *
 * Unsupported: table name held in a variable (`.from(table)`); only string
 * literals are scanned.
 *
 * `issues` has PK (book_id, id), and issue ids repeat across books. A chain
 * that filters only by id (or a child table that filters only by issue_id)
 * can hit the wrong book once a second issue-1 lands.
 *
 * A chain runs from one `.from(<table literal>)` to the next `.from(` or
 * the terminating `;`. book_id scopes a chain only as a real filter,
 * match/insert/upsert key, or onConflict entry, not via select/update text.
 *
 * Run: pnpm tsx scripts/check-issue-scoping.ts
 *
 * No env, no network. Exit 1 when anything is reported, 0 otherwise.
 * Stdout is one path:line per finding, sorted by path then line.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SELF = "scripts/check-issue-scoping.ts";

/** Replace // and /* comments with spaces; keep newlines so line numbers hold. */
function scrubComments(source: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    const n = source[i + 1];

    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out.push(c);
      i++;
      while (i < source.length) {
        const ch = source[i]!;
        out.push(ch);
        if (ch === "\\") {
          i++;
          if (i < source.length) out.push(source[i]!);
          i++;
          continue;
        }
        if (ch === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (c === "/" && n === "/") {
      out.push(" ");
      out.push(" ");
      i += 2;
      while (i < source.length && source[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }

    if (c === "/" && n === "*") {
      out.push(" ");
      out.push(" ");
      i += 2;
      while (i < source.length) {
        if (source[i] === "*" && source[i + 1] === "/") {
          out.push(" ");
          out.push(" ");
          i += 2;
          break;
        }
        out.push(source[i] === "\n" ? "\n" : " ");
        i++;
      }
      continue;
    }

    out.push(c);
    i++;
  }
  return out.join("");
}

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

/** Skip a string literal starting at `i` (quote char). Returns index after close. */
function skipString(source: string, i: number): number {
  const quote = source[i]!;
  i++;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    i++;
  }
  return i;
}

/** Read a quoted name at `i`. Backticks with `${` are rejected (interpolation). */
function readQuotedName(
  source: string,
  i: number,
): { value: string; end: number } | null {
  const quote = source[i];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  let j = i + 1;
  let value = "";
  while (j < source.length) {
    const ch = source[j]!;
    if (quote === "`" && ch === "$" && source[j + 1] === "{") return null;
    if (ch === "\\") {
      j++;
      if (j >= source.length) return null;
      value += source[j]!;
      j++;
      continue;
    }
    if (ch === quote) return { value, end: j + 1 };
    value += ch;
    j++;
  }
  return null;
}

function skipWs(source: string, i: number): number {
  while (i < source.length && /\s/.test(source[i]!)) i++;
  return i;
}

type FromHit = { table: string; fromStart: number; afterFrom: number };

function findFromCalls(source: string): FromHit[] {
  const hits: FromHit[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(source, i);
      continue;
    }
    if (c === "." && source.startsWith("from", i + 1)) {
      let j = i + 5;
      // Reject `.fromX` / `.fromore`: method name must end before `(` / space.
      if (j < source.length && /[\w$]/.test(source[j]!)) {
        i++;
        continue;
      }
      while (j < source.length && /\s/.test(source[j]!)) j++;
      if (source[j] === "(") {
        j++;
        while (j < source.length && /\s/.test(source[j]!)) j++;
        const q = readQuotedName(source, j);
        if (q) {
          let k = q.end;
          while (k < source.length && /\s/.test(source[k]!)) k++;
          if (source[k] === ")") {
            hits.push({
              table: q.value,
              fromStart: i,
              afterFrom: k + 1,
            });
            i = k + 1;
            continue;
          }
        }
      }
    }
    i++;
  }
  return hits;
}

/** End of chain: next `.from(` or `;`, skipping strings. */
function chainEnd(source: string, afterFrom: number): number {
  let i = afterFrom;
  while (i < source.length) {
    const c = source[i]!;
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(source, i);
      continue;
    }
    if (c === ";") return i;
    if (c === "." && source.startsWith("from", i + 1)) {
      let j = i + 5;
      if (j < source.length && /[\w$]/.test(source[j]!)) {
        i++;
        continue;
      }
      while (j < source.length && /\s/.test(source[j]!)) j++;
      if (source[j] === "(") return i;
    }
    i++;
  }
  return source.length;
}

/** Top-level keys of an object literal starting at `{`. */
function objectKeys(
  source: string,
  openBrace: number,
): { keys: string[]; end: number } | null {
  if (source[openBrace] !== "{") return null;
  const keys: string[] = [];
  let i = openBrace + 1;
  let depth = 1;
  let bracketDepth = 0;
  let state: "key" | "value" = "key";

  while (i < source.length && depth > 0) {
    i = skipWs(source, i);
    if (i >= source.length) break;
    const c = source[i]!;

    if (c === '"' || c === "'" || c === "`") {
      if (depth === 1 && bracketDepth === 0 && state === "key") {
        const q = readQuotedName(source, i);
        if (q) {
          keys.push(q.value);
          i = skipWs(source, q.end);
          if (source[i] === ":") {
            state = "value";
            i++;
          }
          continue;
        }
      }
      i = skipString(source, i);
      continue;
    }

    if (
      depth === 1 &&
      bracketDepth === 0 &&
      state === "key" &&
      /[A-Za-z_$]/.test(c)
    ) {
      let j = i + 1;
      while (j < source.length && /[\w$]/.test(source[j]!)) j++;
      keys.push(source.slice(i, j));
      i = skipWs(source, j);
      if (source[i] === ":") {
        state = "value";
        i++;
      }
      continue;
    }

    if (c === "{") {
      depth++;
      i++;
      continue;
    }
    if (c === "}") {
      depth--;
      i++;
      if (depth === 0) return { keys, end: i };
      if (depth === 1 && bracketDepth === 0) state = "key";
      continue;
    }
    if (c === "[") {
      bracketDepth++;
      i++;
      continue;
    }
    if (c === "]") {
      bracketDepth--;
      i++;
      continue;
    }
    if (depth === 1 && bracketDepth === 0 && c === ",") {
      state = "key";
      i++;
      continue;
    }
    if (depth === 1 && bracketDepth === 0 && c === ":") {
      state = "value";
      i++;
      continue;
    }
    i++;
  }
  return null;
}

/** First-arg object or array-of-objects keys for .insert/.upsert/.match. */
function payloadKeys(source: string, openParen: number): string[] {
  let i = skipWs(source, openParen + 1);
  const keys: string[] = [];
  if (source[i] === "{") {
    const obj = objectKeys(source, i);
    if (obj) keys.push(...obj.keys);
    return keys;
  }
  if (source[i] === "[") {
    i++;
    while (i < source.length) {
      i = skipWs(source, i);
      if (source[i] === "]") break;
      if (source[i] === "{") {
        const obj = objectKeys(source, i);
        if (!obj) break;
        keys.push(...obj.keys);
        i = obj.end;
        i = skipWs(source, i);
        if (source[i] === ",") i++;
        continue;
      }
      while (i < source.length && source[i] !== "," && source[i] !== "]") {
        if (source[i] === '"' || source[i] === "'" || source[i] === "`") {
          i = skipString(source, i);
          continue;
        }
        i++;
      }
      if (source[i] === ",") i++;
    }
  }
  return keys;
}

function findMethodCalls(chain: string, method: string): number[] {
  const starts: number[] = [];
  let i = 0;
  while (i < chain.length) {
    const c = chain[i]!;
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(chain, i);
      continue;
    }
    if (c === "." && chain.startsWith(method, i + 1)) {
      const after = i + 1 + method.length;
      if (after < chain.length && /[\w$]/.test(chain[after]!)) {
        i++;
        continue;
      }
      const j = skipWs(chain, after);
      if (chain[j] === "(") starts.push(i);
      i = after;
      continue;
    }
    i++;
  }
  return starts;
}

function hasBookIdFilterCall(chain: string): boolean {
  let i = 0;
  while (i < chain.length) {
    const c = chain[i]!;
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(chain, i);
      continue;
    }
    if (c === ".") {
      let methodLen = 0;
      if (chain.startsWith("filter", i + 1)) methodLen = 6;
      else if (chain.startsWith("eq", i + 1)) methodLen = 2;
      else if (chain.startsWith("in", i + 1)) methodLen = 2;
      if (methodLen > 0) {
        const after = i + 1 + methodLen;
        if (after < chain.length && /[\w$]/.test(chain[after]!)) {
          i++;
          continue;
        }
        let j = skipWs(chain, after);
        if (chain[j] === "(") {
          j = skipWs(chain, j + 1);
          const q = readQuotedName(chain, j);
          if (q?.value === "book_id") return true;
        }
        i = after;
        continue;
      }
    }
    i++;
  }
  return false;
}

function hasOnConflictBookId(chain: string): boolean {
  let i = 0;
  while (i < chain.length) {
    const c = chain[i]!;
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(chain, i);
      continue;
    }
    if (
      chain.startsWith("onConflict", i) &&
      (i === 0 || !/[\w$]/.test(chain[i - 1]!))
    ) {
      let j = skipWs(chain, i + "onConflict".length);
      if (chain[j] === ":") {
        j = skipWs(chain, j + 1);
        const q = readQuotedName(chain, j);
        if (q && /(^|,)\s*book_id\s*(,|$)/.test(q.value)) return true;
      }
    }
    i++;
  }
  return false;
}

function chainHasBookIdScope(chain: string): boolean {
  if (hasBookIdFilterCall(chain)) return true;
  if (hasOnConflictBookId(chain)) return true;
  for (const method of ["match", "insert", "upsert"] as const) {
    for (const start of findMethodCalls(chain, method)) {
      const j = skipWs(chain, start + 1 + method.length);
      if (chain[j] !== "(") continue;
      if (payloadKeys(chain, j).includes("book_id")) return true;
    }
  }
  return false;
}

function collectIdHits(
  source: string,
  chainStart: number,
  chain: string,
  column: "id" | "issue_id",
): number[] {
  const lines: number[] = [];
  let i = 0;
  while (i < chain.length) {
    const c = chain[i]!;
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(chain, i);
      continue;
    }
    if (c === ".") {
      let method: "eq" | "filter" | "match" | null = null;
      if (chain.startsWith("filter", i + 1)) method = "filter";
      else if (chain.startsWith("match", i + 1)) method = "match";
      else if (chain.startsWith("eq", i + 1)) method = "eq";
      if (method) {
        const after = i + 1 + method.length;
        if (after < chain.length && /[\w$]/.test(chain[after]!)) {
          i++;
          continue;
        }
        let j = skipWs(chain, after);
        if (chain[j] === "(") {
          if (method === "match") {
            if (payloadKeys(chain, j).includes(column)) {
              lines.push(lineAt(source, chainStart + i));
            }
          } else {
            j = skipWs(chain, j + 1);
            const q = readQuotedName(chain, j);
            if (q?.value === column) {
              lines.push(lineAt(source, chainStart + i));
            }
          }
        }
        i = after;
        continue;
      }
    }
    i++;
  }
  return lines;
}

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

function scanFile(path: string): string[] {
  const raw = readFileSync(path, "utf-8");
  const source = scrubComments(raw);
  const findings: string[] = [];

  for (const hit of findFromCalls(source)) {
    const end = chainEnd(source, hit.afterFrom);
    const chain = source.slice(hit.fromStart, end);
    if (chainHasBookIdScope(chain)) continue;

    const column = hit.table === "issues" ? "id" : "issue_id";
    for (const line of collectIdHits(source, hit.fromStart, chain, column)) {
      findings.push(`${path}:${line}`);
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
  const seen = new Set<string>();
  for (const f of findings) {
    if (seen.has(f)) continue;
    seen.add(f);
    console.log(f);
  }
  process.exit(seen.size > 0 ? 1 : 0);
}

main();

/**
 * Compare repeated bench runs (#441): `compareRuns` from bench-kit.ts over
 * the `RunFile`s of one bench. Reads only; no model call, no Supabase.
 *
 * By default it takes every complete run of `--bench` in `--dir`; partial
 * runs (a `--max-calls` probe, a stopped run) are left out unless
 * `--include-partial`. `--since` keeps runs started at or after an ISO time,
 * `--arms A,B` keeps those arms, `--files a.json,b.json` names the files.
 *
 * Usage:
 *   pnpm exec tsx scripts/bench/compare-runs.ts --bench face-id \
 *     [--dir ~/comic-reader-bench] [--arms A,B,C] [--since <ISO time>] \
 *     [--include-partial] [--files a.json,b.json]
 */
import { readFileSync } from "node:fs";
import {
  DEFAULT_OUT,
  type RunFile,
  benchCli,
  compareRuns,
  readRunFiles,
} from "./bench-kit";

const { opt, flag, die } = benchCli("compare-runs");
const bench = opt("--bench") ?? die("--bench is required (e.g. face-id)");
const dir = opt("--dir") ?? DEFAULT_OUT;
const filesArg = opt("--files");
const armsArg = opt("--arms");
const since = opt("--since");

let files: RunFile[] = filesArg
  ? filesArg.split(",").map((path) => ({
      ...(JSON.parse(readFileSync(path, "utf8")) as RunFile),
      path,
    }))
  : readRunFiles(dir, bench);
files = files.filter((f) => f.bench === bench);
if (!flag("--include-partial")) files = files.filter((f) => f.complete);
if (since) files = files.filter((f) => f.startedAt >= since);
if (armsArg) {
  const arms = armsArg.split(",");
  files = files.filter((f) => arms.includes(f.arm));
}
if (files.length === 0) die(`no ${bench} run files match in ${dir}`);

console.log(
  [
    `# ${bench}: ${files.length} run file(s)${filesArg ? "" : ` from ${dir}`}`,
    "",
    ...compareRuns(files),
  ].join("\n"),
);

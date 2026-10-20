#!/usr/bin/env node
/**
 * Shrink stored page WebPs to the PAGE_MAX_EDGE long edge (#943). Dry run by
 * default: every page is encoded in memory and nothing is written.
 *
 *   pnpm reencode-pages -- --book <id> [--issue <issue-id>] [--page N]
 *     [--from webp|raw] [--apply] [--allow-ingested]
 *
 * --from webp (default, free): downloads the comic-pages object, skips it when
 * its long edge is already within the cap, else scales it down, re-encodes it
 * with `encodePageWebp`, upserts it to the same key and updates only that
 * page's `pages.width` and `pages.height`. No watermark call.
 *
 * --from raw (paid with --apply): stores the page's newest comic-pages-raw
 * object (under `issues.source_pages_path`) through `storePageImage`, so the
 * watermark clean runs again: one Gemini detect call per page and an image
 * edit per overlay. --apply needs LIVE_API_OK=1. Its dry run calls no API: it
 * scales and encodes the raw page as it is, before any clean, so its new
 * bytes are an estimate.
 *
 * An issue with `bubbles` or `panels` rows is refused under --apply unless
 * --allow-ingested is passed, because their stored positions were made on the
 * page at its current size. The dry run measures it anyway and says so.
 *
 * Per page it prints old and new bytes and dimensions, then a total.
 */

import { parseArgs } from "node:util";
import sharp from "sharp";
import { supabase } from "./lib/supabase.js";
import { listBookIssues, selectIssue } from "~/lib/issue-queries.js";
import {
  capPageSize,
  encodePageWebp,
  PAGE_MAX_EDGE,
  storePageImage,
} from "~/lib/page-images.js";
import { pageStoragePath } from "~/lib/storage.js";

const PAGES_BUCKET = "comic-pages";
const RAW_BUCKET = "comic-pages-raw";
const USAGE =
  "Usage: pnpm reencode-pages -- --book <id> [--issue <issue-id>] [--page N] [--from webp|raw] [--apply] [--allow-ingested]";

interface Args {
  book: string;
  issue?: string;
  page?: number;
  from: "webp" | "raw";
  apply: boolean;
  allowIngested: boolean;
}

interface PageRow {
  number: number;
  width: number | null;
  height: number | null;
}

interface Totals {
  pages: number;
  resized: number;
  oldBytes: number;
  newBytes: number;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function readArgs(): Args {
  const { values } = parseArgs({
    // pnpm passes a leading `--` through; parseArgs would end options there.
    args: process.argv.slice(2).filter((a) => a !== "--"),
    options: {
      book: { type: "string" },
      issue: { type: "string" },
      page: { type: "string" },
      from: { type: "string", default: "webp" },
      apply: { type: "boolean", default: false },
      "allow-ingested": { type: "boolean", default: false },
    },
  });
  if (!values.book) fail(USAGE);
  if (values.from !== "webp" && values.from !== "raw") {
    fail(`--from must be webp or raw, not "${values.from}".\n${USAGE}`);
  }
  let page: number | undefined;
  if (values.page !== undefined) {
    page = Number(values.page);
    if (!Number.isInteger(page) || page < 1) {
      fail(`--page must be a page number from 1, not "${values.page}".`);
    }
    if (!values.issue) fail("--page needs --issue.");
  }
  return {
    book: values.book,
    issue: values.issue,
    page,
    from: values.from,
    apply: values.apply,
    allowIngested: values["allow-ingested"],
  };
}

const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const dims = (w: number | null | undefined, h: number | null | undefined) =>
  `${w ?? "?"}x${h ?? "?"}`;
const pad = (n: number) => String(n).padStart(2, "0");

async function download(bucket: string, key: string): Promise<Buffer> {
  const { data, error } = await supabase.storage.from(bucket).download(key);
  if (error || !data) {
    throw new Error(
      `download ${bucket}/${key}: ${error?.message ?? "no data"}`,
    );
  }
  return Buffer.from(await data.arrayBuffer());
}

/** Rows that hold positions made on the page at its current size. */
async function ingestedRows(bookId: string, issueId: string) {
  const counts: Record<"bubbles" | "panels", number> = {
    bubbles: 0,
    panels: 0,
  };
  for (const table of ["bubbles", "panels"] as const) {
    const { count, error } = await supabase
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("book_id", bookId)
      .eq("issue_id", issueId);
    if (error) throw new Error(`${table} count: ${error.message}`);
    counts[table] = count ?? 0;
  }
  return counts;
}

/** Each page's newest raw object, as upload-source-page picks it. */
async function rawKeys(
  bookId: string,
  issueId: string,
  sourcePath: string | null,
): Promise<Map<number, string>> {
  const prefix = (sourcePath ?? `${bookId}/${issueId}/source/`).replace(
    /\/+$/,
    "",
  );
  const newest = new Map<number, { key: string; updated: string }>();
  const limit = 1000;
  for (let offset = 0; ; offset += limit) {
    const { data, error } = await supabase.storage
      .from(RAW_BUCKET)
      .list(prefix, { limit, offset });
    if (error)
      throw new Error(`list ${RAW_BUCKET}/${prefix}: ${error.message}`);
    for (const f of data) {
      const match = /^page-(\d+)\.[a-z0-9]+$/i.exec(f.name);
      if (!match) continue;
      const page = Number(match[1]);
      const updated = f.updated_at ?? "";
      const seen = newest.get(page);
      if (!seen || updated > seen.updated) {
        newest.set(page, { key: `${prefix}/${f.name}`, updated });
      }
    }
    if (data.length < limit) break;
  }
  return new Map(Array.from(newest, ([page, { key }]) => [page, key]));
}

/** Stored object sizes for one issue's comic-pages folder, by key. */
async function storedSizes(
  bookId: string,
  issueId: string,
): Promise<Map<string, number>> {
  const prefix = `${bookId}/${issueId}`;
  const sizes = new Map<string, number>();
  const limit = 1000;
  for (let offset = 0; ; offset += limit) {
    const { data, error } = await supabase.storage
      .from(PAGES_BUCKET)
      .list(prefix, { limit, offset });
    if (error) {
      throw new Error(`list ${PAGES_BUCKET}/${prefix}: ${error.message}`);
    }
    for (const f of data) {
      const size = (f.metadata as { size?: number } | null)?.size;
      if (typeof size === "number") sizes.set(`${prefix}/${f.name}`, size);
    }
    if (data.length < limit) break;
  }
  return sizes;
}

async function updatePageDims(
  bookId: string,
  issueId: string,
  page: number,
  width: number,
  height: number,
) {
  const { data, error } = await supabase
    .from("pages")
    .update({ width, height })
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("number", page)
    .select("number");
  if (error) {
    throw new Error(`pages update for page ${page}: ${error.message}`);
  }
  if (data.length !== 1) {
    throw new Error(
      `pages update for page ${page} matched ${data.length} rows`,
    );
  }
}

async function fromWebp(
  args: Args,
  issueId: string,
  row: PageRow,
  totals: Totals,
) {
  const key = pageStoragePath(args.book, issueId, row.number);
  const head = `  page ${pad(row.number)}`;
  const input = await download(PAGES_BUCKET, key);
  const meta = await sharp(input).metadata();
  const rowNote =
    meta.width !== row.width || meta.height !== row.height
      ? ` (pages row says ${dims(row.width, row.height)})`
      : "";
  totals.pages++;
  totals.oldBytes += input.length;
  if (Math.max(meta.width ?? 0, meta.height ?? 0) <= PAGE_MAX_EDGE) {
    totals.newBytes += input.length;
    console.log(
      `${head}: ${kb(input.length)} ${dims(meta.width, meta.height)}${rowNote}, within ${PAGE_MAX_EDGE} px, skipped`,
    );
    return;
  }
  const capped = await capPageSize(input);
  const webp = await encodePageWebp(capped.buffer);
  totals.resized++;
  totals.newBytes += webp.length;
  console.log(
    `${head}: ${kb(input.length)} ${dims(meta.width, meta.height)}${rowNote} -> ${kb(webp.length)} ${dims(capped.width, capped.height)}`,
  );
  if (!args.apply) return;
  const { error } = await supabase.storage
    .from(PAGES_BUCKET)
    .upload(key, webp, { contentType: "image/webp", upsert: true });
  if (error) throw new Error(`upload ${PAGES_BUCKET}/${key}: ${error.message}`);
  await updatePageDims(
    args.book,
    issueId,
    row.number,
    capped.width,
    capped.height,
  );
}

async function fromRaw(
  args: Args,
  issueId: string,
  row: PageRow,
  rawKey: string | undefined,
  sizes: Map<string, number>,
  totals: Totals,
) {
  const key = pageStoragePath(args.book, issueId, row.number);
  const head = `  page ${pad(row.number)}`;
  if (!rawKey) {
    console.log(`${head}: no raw page in ${RAW_BUCKET}, skipped`);
    return;
  }
  const oldBytes = sizes.get(key);
  if (oldBytes === undefined) {
    console.log(`${head}: no stored ${PAGES_BUCKET}/${key}, skipped`);
    return;
  }
  const raw = await download(RAW_BUCKET, rawKey);
  totals.pages++;
  totals.oldBytes += oldBytes;
  if (!args.apply) {
    // No watermark clean in a dry run: it would call Gemini.
    const capped = await capPageSize(raw);
    const webp = await encodePageWebp(capped.buffer);
    totals.resized++;
    totals.newBytes += webp.length;
    console.log(
      `${head}: ${kb(oldBytes)} ${dims(row.width, row.height)} -> ~${kb(webp.length)} ${dims(capped.width, capped.height)} (raw ${kb(raw.length)}, before the watermark clean)`,
    );
    return;
  }
  const stored = await storePageImage({
    bookId: args.book,
    issueId,
    pageNumber: row.number,
    buffer: raw,
  });
  totals.resized++;
  const watermark =
    stored.fixes.length + stored.failures.length > 0
      ? `, watermark: ${stored.fixes.length} fixed, ${stored.failures.length} left${stored.failures.length > 0 ? ` (${stored.failures.map((f) => f.reason).join(", ")})` : ""}`
      : "";
  console.log(
    `${head}: ${kb(oldBytes)} ${dims(row.width, row.height)} -> ${dims(stored.width, stored.height)}${watermark}`,
  );
}

async function main() {
  const args = readArgs();
  if (args.from === "raw" && args.apply && process.env.LIVE_API_OK !== "1") {
    fail(
      "Paid: --from raw --apply runs the watermark clean on every page, one Gemini detect call per page and an image edit per overlay. Re-run it as LIVE_API_OK=1 pnpm reencode-pages ... only if the task named that spend.",
    );
  }

  const issueQuery = args.issue
    ? selectIssue(supabase, args.book, args.issue, "id, source_pages_path")
    : listBookIssues(supabase, args.book, "id, source_pages_path");
  const { data: issues, error: issuesErr } = await issueQuery.order("id");
  if (issuesErr) fail(`issues for ${args.book}: ${issuesErr.message}`);
  if (issues.length === 0) {
    fail(`No issue ${args.issue ? `${args.issue} ` : ""}in book ${args.book}.`);
  }

  // Every issue is checked before the first write, so a refusal leaves the
  // book as it was.
  const refused: string[] = [];
  for (const issue of issues) {
    const rows = await ingestedRows(args.book, issue.id);
    if (rows.bubbles + rows.panels === 0) continue;
    refused.push(
      `${issue.id} has ${rows.bubbles} bubbles and ${rows.panels} panels rows. Their positions were made on the page at its current size, so shrinking it is held until the coordinate check (#943) clears it; pass --allow-ingested once it has.`,
    );
  }
  if (refused.length > 0 && !args.allowIngested) {
    if (args.apply)
      fail(`Refused, nothing written:\n  ${refused.join("\n  ")}`);
    console.log(
      `--apply would refuse without --allow-ingested:\n  ${refused.join("\n  ")}\n`,
    );
  }

  console.log(
    `${args.book}: ${issues.length} issue(s), from ${args.from}, cap ${PAGE_MAX_EDGE} px, ${args.apply ? "APPLY" : "dry run"}`,
  );
  const grand: Totals = { pages: 0, resized: 0, oldBytes: 0, newBytes: 0 };
  for (const issue of issues) {
    let pageQuery = supabase
      .from("pages")
      .select("number, width, height")
      .eq("book_id", args.book)
      .eq("issue_id", issue.id);
    if (args.page !== undefined) pageQuery = pageQuery.eq("number", args.page);
    const { data: rows, error } = await pageQuery.order("number");
    if (error) fail(`pages for ${issue.id}: ${error.message}`);
    console.log(`\n${issue.id}: ${rows.length} page(s)`);

    const raw =
      args.from === "raw"
        ? {
            keys: await rawKeys(args.book, issue.id, issue.source_pages_path),
            sizes: await storedSizes(args.book, issue.id),
          }
        : undefined;
    const totals: Totals = { pages: 0, resized: 0, oldBytes: 0, newBytes: 0 };
    for (const row of rows as PageRow[]) {
      if (raw) {
        await fromRaw(
          args,
          issue.id,
          row,
          raw.keys.get(row.number),
          raw.sizes,
          totals,
        );
      } else {
        await fromWebp(args, issue.id, row, totals);
      }
    }
    if (raw && args.apply) {
      // storePageImage does not hand back the encoded size; read it back for
      // the pages fromRaw stored (both a raw page and a stored one existed).
      const after = await storedSizes(args.book, issue.id);
      for (const row of rows) {
        const key = pageStoragePath(args.book, issue.id, row.number);
        if (!raw.keys.has(row.number) || !raw.sizes.has(key)) continue;
        totals.newBytes += after.get(key) ?? 0;
      }
    }
    printTotals(`${issue.id} total`, totals);
    grand.pages += totals.pages;
    grand.resized += totals.resized;
    grand.oldBytes += totals.oldBytes;
    grand.newBytes += totals.newBytes;
  }
  if (issues.length > 1) printTotals(`\n${args.book} total`, grand);
  console.log(
    args.apply
      ? "\nApplied."
      : "\nDry run: nothing written. Pass --apply to write.",
  );
}

function printTotals(label: string, t: Totals) {
  const saved =
    t.oldBytes > 0
      ? `${(((t.oldBytes - t.newBytes) / t.oldBytes) * 100).toFixed(1)}%`
      : "n/a";
  console.log(
    `${label}: ${t.pages} page(s), ${t.resized} resized, ${mb(t.oldBytes)} -> ${mb(t.newBytes)}, ${saved} saved`,
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

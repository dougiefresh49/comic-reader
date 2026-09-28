#!/usr/bin/env node
/**
 * Sweep the bubble and panel detection thresholds against the reviewed boxes (#180).
 *
 *   pnpm sweep-thresholds truth   [--book B] [--issues issue-1,issue-2,issue-3] [--panel-issues issue-1]
 *   pnpm sweep-thresholds capture --count N [--book B] [--issues ...] [--panel-issues ...]
 *   pnpm sweep-thresholds report  [--book B]
 *
 * truth: free. SELECTs the reviewed boxes and writes one
 *   fixtures/thresholds/<book>/<issue>/page-NN.truth.json per `pages` row.
 *   Bubbles with ignored = true, or a box_2d without a positive width and
 *   height, are left out. `panels` is null on a page with no panel rows, or
 *   in an issue not named by --panel-issues, and the panel model is not called
 *   or scored on that page. Only issue-1's panel rows have been reviewed; the
 *   others come straight from the model and would score it against itself.
 * capture: PAID. Runs truth first, so newly reviewed pages join. Then one
 *   Roboflow call per model per page that has a truth file with non-null
 *   boxes for that model and no page-NN.<model>.json yet, at confidence
 *   FLOOR. It prints the count and the pages, then refuses to start unless --count equals that count and
 *   the count is at most MAX_CALLS. Each file is written as soon as its call
 *   returns; the first failed call stops the run.
 * report: no network. Replays every saved prediction at 0.05..0.95.
 *
 * Coordinates: both sides become fractions of the page before IoU. A truth
 * box is stored that way (bubble pixels / pages.width,height; panel
 * bounding_box is already a fraction). A prediction is a centre-pixel box
 * divided by the image size Roboflow reports in the same response.
 *
 * Matching, per page and threshold: predictions at or above the threshold
 * are taken highest confidence first; each takes the unmatched reviewed box
 * with the highest IoU, if that IoU is at least 0.5. Each reviewed box and
 * each prediction matches at most once. Unmatched predictions are extras,
 * unmatched reviewed boxes are misses. "best" is the highest recall with
 * precision at least 0.9; a tie goes to the lowest threshold.
 */

import fs from "fs";
import path from "path";
import { pageImageUrl } from "~/lib/storage.js";

const ROOT = path.join(process.cwd(), "fixtures", "thresholds");
const MODELS = {
  bubbles: {
    id: "find-speech-bubbles-fmu3y/4",
    inUse: "0.30 (v3), 0.40 (legacy)",
  },
  panels: { id: "find-comic-panel-v1/1", inUse: "0.40 (v3)" },
} as const;
type ModelKey = keyof typeof MODELS;
const MODEL_KEYS = Object.keys(MODELS) as ModelKey[];
const FLOOR = 0.05;
const MAX_CALLS = 148;
const IOU_MATCH = 0.5;
const THRESHOLDS = Array.from({ length: 19 }, (_, i) => (i + 1) / 20);

/** x, y = top-left corner; all four are fractions of the page. */
type Box = { x: number; y: number; w: number; h: number };
type TruthBox = { id: string; box: Box };
type TruthFile = {
  width: number;
  height: number;
  bubbles: TruthBox[];
  panels: TruthBox[] | null;
};
type RawPrediction = {
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
};
type PredictionFile = {
  model: string;
  floor: number;
  response: {
    image?: { width: number; height: number };
    predictions?: RawPrediction[];
  };
};
type Page = { issue: string; page: string; dir: string };

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** Pages under <book> that have a truth file. */
function truthPages(book: string): Page[] {
  const bookDir = path.join(ROOT, book);
  if (!fs.existsSync(bookDir)) return [];
  return fs
    .readdirSync(bookDir)
    .sort()
    .flatMap((issue) =>
      fs
        .readdirSync(path.join(bookDir, issue))
        .filter((f) => f.endsWith(".truth.json"))
        .sort()
        .map((f) => ({
          issue,
          page: f.replace(".truth.json", ""),
          dir: path.join(bookDir, issue),
        })),
    );
}

async function truth(book: string, issues: string[], panelIssues: string[]) {
  const { supabase } = await import("./lib/supabase.js");
  for (const issue of issues) {
    const q = (table: "pages" | "bubbles" | "panels", cols: string) =>
      supabase
        .from(table)
        .select(cols)
        .eq("book_id", book)
        .eq("issue_id", issue);
    const [pages, bubbles, panels] = await Promise.all([
      q("pages", "number, width, height"),
      q("bubbles", "id, page_number, box_2d, ignored"),
      q("panels", "panel_id, page_number, bounding_box"),
    ]);
    const err = pages.error ?? bubbles.error ?? panels.error;
    if (err) fail(`SELECT failed for ${book}/${issue}: ${err.message}`);
    const pageRows = pages.data as unknown as {
      number: number;
      width: number;
      height: number;
    }[];
    const bubbleRows = bubbles.data as unknown as {
      id: string;
      page_number: number;
      box_2d: Record<string, unknown> | null;
      ignored: boolean;
    }[];
    const panelRows = panels.data as unknown as {
      panel_id: string;
      page_number: number;
      bounding_box: Box;
    }[];
    const dir = path.join(ROOT, book, issue);
    fs.mkdirSync(dir, { recursive: true });
    let kept = 0;
    let dropped = 0;
    for (const p of pageRows) {
      const out: TruthFile = {
        width: p.width,
        height: p.height,
        bubbles: [],
        panels: null,
      };
      for (const b of bubbleRows.filter((r) => r.page_number === p.number)) {
        const { x, y, width, height } = (b.box_2d ?? {}) as Record<
          string,
          number
        >;
        if (b.ignored || !(Number(width) > 0) || !(Number(height) > 0)) {
          dropped++;
          continue;
        }
        const box = {
          x: x! / p.width,
          y: y! / p.height,
          w: width! / p.width,
          h: height! / p.height,
        };
        out.bubbles.push({ id: b.id, box });
      }
      const pagePanels = panelRows.filter((r) => r.page_number === p.number);
      if (panelIssues.includes(issue) && pagePanels.length > 0) {
        out.panels = pagePanels.map((r) => ({
          id: r.panel_id,
          box: r.bounding_box,
        }));
      }
      kept += out.bubbles.length;
      const name = `page-${String(p.number).padStart(2, "0")}.truth.json`;
      fs.writeFileSync(
        path.join(dir, name),
        JSON.stringify(out, null, 1) + "\n",
      );
    }
    const panelPages = new Set(panelRows.map((r) => r.page_number)).size;
    console.log(
      `${book}/${issue}: ${pageRows.length} pages, ${kept} bubbles kept, ${dropped} left out, panel rows on ${panelPages} pages`,
    );
  }
}

async function capture(book: string, issues: string[], panelIssues: string[]) {
  // Newly reviewed pages count (decision 3): refresh the truth files first.
  await truth(book, issues, panelIssues);
  const work = truthPages(book).flatMap((p) => {
    const t = readJson<TruthFile>(path.join(p.dir, `${p.page}.truth.json`));
    return MODEL_KEYS.filter(
      (m) =>
        t[m] !== null &&
        !fs.existsSync(path.join(p.dir, `${p.page}.${m}.json`)),
    ).map((m) => ({ ...p, model: m }));
  });
  console.log(
    `capture would make ${work.length} Roboflow call(s) at confidence ${FLOOR}:`,
  );
  for (const w of work)
    console.log(`  ${w.issue}/${w.page} ${MODELS[w.model].id}`);
  if (work.length === 0) return console.log("Nothing to capture.");
  if (flag("count") !== String(work.length)) {
    fail(
      `Refusing: pass --count ${work.length} to confirm this spend. No call was made.`,
    );
  }
  if (work.length > MAX_CALLS)
    fail(`Refusing: ${work.length} is over ${MAX_CALLS}. No call was made.`);
  const key = process.env.ROBOFLOW_API_KEY;
  if (!key) fail("Refusing: ROBOFLOW_API_KEY is empty. No call was made.");

  for (const [i, w] of work.entries()) {
    const pageNumber = Number(w.page.replace("page-", ""));
    const url = new URL(
      `https://serverless.roboflow.com/${MODELS[w.model].id}`,
    );
    url.searchParams.set("api_key", key);
    url.searchParams.set("confidence", String(FLOOR));
    url.searchParams.set("image", pageImageUrl(book, w.issue, pageNumber));
    // The URL carries the key: never log it or let it into an error message.
    const res = await fetch(url, { method: "POST" });
    const body = (await res.json().catch(() => null)) as
      | PredictionFile["response"]
      | null;
    if (!res.ok || !Array.isArray(body?.predictions)) {
      fail(
        `${w.issue}/${w.page} ${w.model}: HTTP ${res.status}, no predictions. Stopped after ${i} call(s).`,
      );
    }
    const out: PredictionFile = {
      model: MODELS[w.model].id,
      floor: FLOOR,
      response: body,
    };
    fs.writeFileSync(
      path.join(w.dir, `${w.page}.${w.model}.json`),
      JSON.stringify(out) + "\n",
    );
    const n = body.predictions.length;
    // Hosted inference returns at most 300 detections by default (max_detections).
    console.log(
      `  saved ${w.issue}/${w.page}.${w.model} (${n} predictions${n >= 300 ? ", CAPPED" : ""})`,
    );
  }
}

function iou(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

/** Ids of the reviewed boxes matched at threshold t (rule in the header). */
function match(
  truthBoxes: TruthBox[],
  preds: { box: Box; confidence: number }[],
  t: number,
) {
  const matched = new Set<string>();
  let extras = 0;
  for (const p of preds.filter((q) => q.confidence >= t)) {
    let best: TruthBox | undefined;
    let bestIou = IOU_MATCH;
    for (const g of truthBoxes) {
      const v = matched.has(g.id) ? 0 : iou(g.box, p.box);
      if (v >= bestIou) [best, bestIou] = [g, v];
    }
    if (best) matched.add(best.id);
    else extras++;
  }
  return { matched, extras };
}

function report(book: string) {
  const pages = truthPages(book);
  if (pages.length === 0)
    fail(`No truth files under fixtures/thresholds/${book}. Run truth first.`);
  let printed = 0;
  for (const m of MODEL_KEYS) {
    const scored = pages.flatMap((p) => {
      const file = path.join(p.dir, `${p.page}.${m}.json`);
      const t = readJson<TruthFile>(path.join(p.dir, `${p.page}.truth.json`));
      const truthBoxes = t[m];
      if (!fs.existsSync(file) || truthBoxes === null) return [];
      const { response } = readJson<PredictionFile>(file);
      const img = response.image ?? { width: t.width, height: t.height };
      const preds = (response.predictions ?? [])
        .map((r) => ({
          confidence: r.confidence,
          box: {
            x: (r.x - r.width / 2) / img.width,
            y: (r.y - r.height / 2) / img.height,
            w: r.width / img.width,
            h: r.height / img.height,
          },
        }))
        .sort((a, b) => b.confidence - a.confidence);
      return [{ ...p, truthBoxes, preds }];
    });
    if (scored.length === 0) {
      console.log(
        `\n${MODELS[m].id}: no saved predictions on a page with reviewed ${m}.`,
      );
      continue;
    }
    printed++;
    const total = scored.reduce((n, s) => n + s.truthBoxes.length, 0);
    // Panel ids repeat across issues, so a found box is keyed by where it lives.
    const key = (s: Page, id: string) => `${book}/${s.issue}/${s.page}/${id}`;
    const found = new Set<string>();
    const rows = THRESHOLDS.map((t) => {
      let tp = 0;
      let extras = 0;
      for (const s of scored) {
        const r = match(s.truthBoxes, s.preds, t);
        tp += r.matched.size;
        extras += r.extras;
        r.matched.forEach((id) => found.add(key(s, id)));
      }
      const precision = tp + extras === 0 ? NaN : tp / (tp + extras);
      return {
        t,
        precision,
        recall: total === 0 ? NaN : tp / total,
        missed: total - tp,
        extras,
      };
    });
    const f = (n: number) => (Number.isNaN(n) ? "  n/a" : n.toFixed(3));
    console.log(
      `\n${MODELS[m].id}: ${scored.length} pages, ${total} reviewed ${m}, IoU >= ${IOU_MATCH}`,
    );
    console.log("threshold  precision  recall  missed  extra");
    for (const r of rows) {
      const cells = [
        r.t.toFixed(2),
        f(r.precision),
        f(r.recall),
        r.missed,
        r.extras,
      ];
      console.log(
        cells.map((c, i) => String(c).padStart([9, 10, 7, 7, 6][i]!)).join(" "),
      );
    }
    const ok = rows.filter((r) => r.precision >= 0.9);
    const best = ok.reduce<(typeof rows)[number] | undefined>(
      (a, r) => (a === undefined || r.recall > a.recall ? r : a),
      undefined,
    );
    console.log(
      best
        ? `best: ${best.t.toFixed(2)} (highest recall with precision >= 0.9: recall ${f(best.recall)}, precision ${f(best.precision)}); in use today: ${MODELS[m].inUse}`
        : `best: none, no threshold reaches precision 0.9; in use today: ${MODELS[m].inUse}`,
    );
    const blind = scored.flatMap((s) =>
      s.truthBoxes
        .filter((g) => !found.has(key(s, g.id)))
        .map((g) => ({
          s,
          g,
          near: Math.max(0, ...s.preds.map((p) => iou(g.box, p.box))),
        })),
    );
    console.log(
      `blind spots (no threshold finds them): ${blind.length}, best IoU with any prediction`,
    );
    for (const { s, g, near } of blind)
      console.log(`  ${s.issue}/${s.page} ${g.id} ${near.toFixed(2)}`);
  }
  if (printed === 0)
    fail(
      `No saved predictions under fixtures/thresholds/${book} yet. Run capture first.`,
    );
}

const book = flag("book") ?? "tmnt-mmpr-iii";
const issues = (flag("issues") ?? "issue-1,issue-2,issue-3").split(",");
const panelIssues = (flag("panel-issues") ?? "issue-1").split(",");
const cmd = process.argv[2];
if (cmd === "truth") {
  await truth(book, issues, panelIssues);
} else if (cmd === "capture") {
  await capture(book, issues, panelIssues);
} else if (cmd === "report") {
  report(book);
} else {
  fail(
    "Usage: sweep-thresholds <truth|capture|report> [--book B] [--issues a,b] [--panel-issues a] [--count N]",
  );
}

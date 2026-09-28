#!/usr/bin/env node
/**
 * Backfill panels, page_segmentation and panel foreground polygons for an
 * issue whose bubbles are already reviewed (#88). The only bubble column it
 * writes is panel_id. Dry run by default; `--execute` writes to PRODUCTION.
 *
 * Usage: pnpm backfill-panels -- --book <book> --issue <issue-N>
 *          [--pages 5 | 3,7 | 1-4] [--execute] [--force] [--cache-dir <dir>]
 *
 * One SAM3 workflow call per page, the call roboflowAnalyzeBatch makes. Each
 * page's response is cached as <cache-dir>/page-NN.json once it parses, and a
 * later run (dry or --execute) calls Roboflow only for pages with no file.
 * The issue must have no panels; --force deletes them first (the run's pages
 * only when --pages is given).
 */

import fs from "fs";
import os from "os";
import path from "path";
import { supabase } from "./lib/supabase.js";
import { isDryRun } from "~/lib/fakes/dry-run";
import { selectIssue } from "~/lib/issue-queries";
import { sortPanelsForReading } from "~/lib/panel-reading-order";
import { runRoboflowWorkflow } from "~/lib/roboflow-client";
import { pageImageUrl } from "~/lib/storage";
import type { TablesInsert } from "~/types/database";
import type {
  PageDirectedPanel,
  PanelBoundingBox,
  PanelForegroundPolygons,
  PanelLocalPolygon,
} from "~/types/panels";
import { queryPageList, rdpSimplify } from "~/workflows/steps/shared";
import {
  mapPanelRows,
  mapSegmentationRow,
  parseRoboflowSam3Output,
  type ParsedRoboflowSam3,
  type RoboflowSam3Output,
} from "~/workflows/steps/vision-rows";

const USAGE =
  "Usage: pnpm backfill-panels -- --book <book> --issue <issue-N> [--pages 5|3,7|1-4] [--execute] [--force] [--cache-dir <dir>]";

type PanelRow = TablesInsert<"panels"> & { bounding_box: PanelBoundingBox };
type Bubble = {
  id: string;
  legacy_id: string;
  page_number: number;
  box_2d: unknown;
};
type Link = { bubble: Bubble; panel: PanelRow | null; how: string };
type PagePlan = {
  pageNumber: number;
  parsed: ParsedRoboflowSam3;
  panels: PanelRow[];
  links: Link[];
};

function fail(why: string): never {
  console.error(why);
  process.exit(1);
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    const next = i >= 0 ? argv[i + 1] : undefined;
    return next && !next.startsWith("--") ? next : undefined;
  };
  const book = value("--book");
  const issue = value("--issue");
  if (!book || !issue) fail(USAGE);
  let pages: Set<number> | undefined;
  if (argv.includes("--pages")) {
    pages = new Set();
    const raw =
      value("--pages") ?? fail("--pages needs a value: 5, 3,7 or 1-4");
    for (const part of raw.split(",")) {
      const m =
        /^(\d+)(?:-(\d+))?$/.exec(part) ??
        fail(`--pages: "${part}" is not N or N-M`);
      const a = Number(m[1]);
      const b = Number(m[2] ?? m[1]);
      if (b < a) fail(`--pages: "${part}" runs backwards`);
      for (let n = a; n <= b; n++) pages.add(n);
    }
  }
  return {
    book,
    issue,
    pages,
    execute: argv.includes("--execute"),
    force: argv.includes("--force"),
    cacheDir:
      value("--cache-dir") ??
      path.join(os.tmpdir(), `backfill-panels-${book}-${issue}`),
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Detected panels in reading order, renumbered so panel_id follows sort_order (the issue-1 shape). */
function orderedPanels(
  book: string,
  issue: string,
  pageNumber: number,
  parsed: ParsedRoboflowSam3,
): PanelRow[] {
  const detected = mapPanelRows(
    book,
    issue,
    pageNumber,
    parsed.panelPredictions,
    parsed.image,
  ) as PanelRow[];
  // sortPanelsForReading reads only boundingBox, sortOrder and source.
  const sorted = sortPanelsForReading(
    detected.map(
      (r, i) =>
        ({
          panelId: String(i),
          sortOrder: i,
          source: "roboflow",
          boundingBox: r.bounding_box,
        }) as unknown as PageDirectedPanel,
    ),
  );
  return sorted.map((p, i) => ({
    ...detected[Number(p.panelId)]!,
    panel_id: `p${pad(pageNumber)}-${pad(i + 1)}`,
    sort_order: i,
  }));
}

/**
 * Ported from extractForegroundMasksBatch (src/workflows/steps/vision.ts): a
 * polygon goes to the first panel in reading order that holds its centroid,
 * in panel-local 0..1 coordinates, simplified to at most 50 vertices.
 */
function attachForegroundPolygons(
  panels: PanelRow[],
  parsed: ParsedRoboflowSam3,
): void {
  const CHARACTER_CLASSES = new Set([
    "comic character",
    "person",
    "face",
    "head",
  ]);
  const MAX_VERTS = 50;
  const { width: imgW, height: imgH } = parsed.image;
  const polys = panels.map(() => ({
    characters: [] as PanelLocalPolygon[],
    bubbles: [] as PanelLocalPolygon[],
  }));

  for (const pred of parsed.segmentationPredictions) {
    const isChar = CHARACTER_CLASSES.has(pred.class);
    if (!isChar && pred.class !== "speech bubble") continue;
    if (pred.points.length < 3) continue;
    const cx = pred.points.reduce((s, p) => s + p.x, 0) / pred.points.length;
    const cy = pred.points.reduce((s, p) => s + p.y, 0) / pred.points.length;
    const i = panels.findIndex(({ bounding_box: b }) => {
      const [x, y, w, h] = [b.x * imgW, b.y * imgH, b.w * imgW, b.h * imgH];
      return cx >= x && cx <= x + w && cy >= y && cy <= y + h;
    });
    if (i < 0) continue;
    const b = panels[i]!.bounding_box;
    const local = pred.points.map((pt) => ({
      x: (pt.x - b.x * imgW) / (b.w * imgW),
      y: (pt.y - b.y * imgH) / (b.h * imgH),
    }));
    let simplified = local;
    for (let eps = 0.005; simplified.length > MAX_VERTS && eps < 0.1; ) {
      simplified = rdpSimplify(local, eps);
      eps *= 1.5;
    }
    polys[i]![isChar ? "characters" : "bubbles"].push(simplified);
  }

  panels.forEach((p, i) => {
    const { characters, bubbles } = polys[i]!;
    if (characters.length > 0 || bubbles.length > 0) {
      p.foreground_polygons = { characters, bubbles };
    }
  });
}

/**
 * Ported from detectPanels (scripts/generate-episode.ts): the smallest panel
 * holding the bubble's box_2d center wins; with none, the nearest panel
 * center. Distances are in page-normalized coordinates, as there.
 */
function linkBubble(
  bubble: Bubble,
  panels: PanelRow[],
  image: { width: number; height: number },
): Link {
  if (panels.length === 0) return { bubble, panel: null, how: "no panels" };
  const box = bubble.box_2d as Record<string, unknown> | null;
  const [x, y, w, h] = ["x", "y", "width", "height"].map((k) => box?.[k]);
  if (![x, y, w, h].every((v) => typeof v === "number")) {
    return { bubble, panel: null, how: "no pixel box_2d" };
  }
  const cx = ((x as number) + (w as number) / 2) / image.width;
  const cy = ((y as number) + (h as number) / 2) / image.height;
  const area = (p: PanelRow) => p.bounding_box.w * p.bounding_box.h;
  const contained = panels
    .filter(({ bounding_box: b }) => {
      return cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h;
    })
    .sort((a, b) => area(a) - area(b))[0];
  if (contained)
    return { bubble, panel: contained, how: "smallest containing" };
  const dist = ({ bounding_box: b }: PanelRow) =>
    Math.hypot(b.x + b.w / 2 - cx, b.y + b.h / 2 - cy);
  const nearest = panels.reduce((a, b) => (dist(b) < dist(a) ? b : a));
  return {
    bubble,
    panel: nearest,
    how: `nearest center, ${dist(nearest).toFixed(3)} away`,
  };
}

function readCache(file: string): ParsedRoboflowSam3 {
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as {
    outputs?: RoboflowSam3Output[];
  };
  return (
    parseRoboflowSam3Output(data.outputs?.[0]) ??
    fail(`${file}: missing or malformed predictions`)
  );
}

async function callRoboflow(
  workflowUrl: string,
  book: string,
  issue: string,
  pageNumber: number,
  file: string,
): Promise<ParsedRoboflowSam3> {
  const res = await runRoboflowWorkflow(workflowUrl, {
    type: "url",
    value: pageImageUrl(book, issue, pageNumber),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new Error(`page ${pageNumber}: Roboflow HTTP ${res.status}: ${body}`);
  }
  const out = ((await res.json()) as { outputs?: RoboflowSam3Output[] })
    .outputs?.[0];
  const parsed = parseRoboflowSam3Output(out);
  if (!out || !parsed) {
    throw new Error(`page ${pageNumber}: missing or malformed predictions`);
  }
  // Only the three prediction objects go to disk: no key, no image URL.
  const { panel_predictions, bubble_predictions, segmentation_predictions } =
    out;
  const cached = {
    outputs: [
      { panel_predictions, bubble_predictions, segmentation_predictions },
    ],
  };
  fs.writeFileSync(file, JSON.stringify(cached));
  return parsed;
}

async function main() {
  const { book, issue, pages, execute, force, cacheDir } = parseArgs();

  const { error: issueErr } = await selectIssue(
    supabase,
    book,
    issue,
    "id",
  ).single();
  if (issueErr) fail(`issues row ${book}/${issue}: ${issueErr.message}`);

  const allPages = await queryPageList(supabase, book, issue);
  const known = new Set(allPages.map((p) => p.pageNumber));
  const unknown = [...(pages ?? [])].filter((n) => !known.has(n));
  if (unknown.length)
    fail(`${book}/${issue} has no page ${unknown.join(", ")}`);
  const runPages = allPages.filter((p) => !pages || pages.has(p.pageNumber));
  const runNumbers = runPages.map((p) => p.pageNumber);

  const { count: existing, error: countErr } = await supabase
    .from("panels")
    .select("id", { count: "exact", head: true })
    .eq("book_id", book)
    .eq("issue_id", issue);
  if (countErr) fail(`panels count: ${countErr.message}`);
  if ((existing ?? 0) > 0 && !force) {
    fail(
      `${book}/${issue} already has ${existing} panels. Refusing. --force deletes this issue's panels first${pages ? " (the --pages pages only)" : ""}, and bubbles on them lose their panel_id.`,
    );
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  const cacheFile = (n: number) => path.join(cacheDir, `page-${pad(n)}.json`);
  const toCall = runNumbers.filter((n) => !fs.existsSync(cacheFile(n)));
  console.log(`${book}/${issue}, ${execute ? "EXECUTE" : "dry run"}`);
  console.log(`Cache: ${cacheDir}`);
  if (force && existing) {
    console.log(
      `--force: ${execute ? "deletes" : "would delete"} ${pages ? `the panels on pages ${runNumbers.join(", ")}` : `all ${existing} panels`} before writing`,
    );
  }
  console.log(
    toCall.length
      ? `Roboflow calls to make: ${toCall.length} (pages ${toCall.join(", ")})`
      : `Roboflow calls to make: 0 (every page is cached)`,
  );

  let workflowUrl = "";
  if (toCall.length) {
    if (isDryRun()) {
      fail("DRY_RUN is set: the fake Roboflow response would be cached.");
    }
    if (!process.env.ROBOFLOW_API_KEY) {
      fail("ROBOFLOW_API_KEY is empty. Stopped before the first request.");
    }
    workflowUrl = (await import("~/env.mjs")).env.ROBOFLOW_SAM3_WORKFLOW_URL;
  }

  const { data: bubbles, error: bubbleErr } = await supabase
    .from("bubbles")
    .select("id, legacy_id, page_number, box_2d")
    .eq("book_id", book)
    .eq("issue_id", issue)
    .in("page_number", runNumbers)
    .order("page_number")
    .order("sort_order");
  if (bubbleErr) fail(`bubbles read: ${bubbleErr.message}`);

  // Every call happens before any write, so a failed call leaves nothing half-written.
  const plans: PagePlan[] = [];
  for (const page of runPages) {
    const n = page.pageNumber;
    const file = cacheFile(n);
    let parsed: ParsedRoboflowSam3;
    if (fs.existsSync(file)) {
      parsed = readCache(file);
    } else {
      parsed = await callRoboflow(workflowUrl, book, issue, n, file);
      await new Promise((r) => setTimeout(r, 750));
    }
    if (
      parsed.image.width !== page.width ||
      parsed.image.height !== page.height
    ) {
      fail(
        `page ${n}: response image ${parsed.image.width}x${parsed.image.height}, pages row ${page.width}x${page.height}. box_2d would not line up.`,
      );
    }
    const panels = orderedPanels(book, issue, n, parsed);
    attachForegroundPolygons(panels, parsed);
    const links = (bubbles as Bubble[])
      .filter((b) => b.page_number === n)
      .map((b) => linkBubble(b, panels, parsed.image));
    plans.push({ pageNumber: n, parsed, panels, links });
  }

  const noPanels: number[] = [];
  for (const { pageNumber: n, panels, links } of plans) {
    const linked = links.filter((l) => l.panel).length;
    const fg = (p: PanelRow) =>
      p.foreground_polygons as PanelForegroundPolygons | undefined;
    const chars = panels.reduce(
      (s, p) => s + (fg(p)?.characters.length ?? 0),
      0,
    );
    const masks = panels.reduce((s, p) => s + (fg(p)?.bubbles.length ?? 0), 0);
    if (panels.length === 0) noPanels.push(n);
    console.log(
      `page ${n}: ${panels.length} panels detected, ${linked} bubbles linked, ${links.length - linked} left unlinked` +
        (panels.length
          ? `, ${chars} character + ${masks} bubble polygons`
          : ", nothing will be written"),
    );
    for (const p of panels) {
      const b = p.bounding_box;
      console.log(
        `  ${p.panel_id} x=${b.x.toFixed(3)} y=${b.y.toFixed(3)} w=${b.w.toFixed(3)} h=${b.h.toFixed(3)}, polygons: ${fg(p)?.characters.length ?? 0} character + ${fg(p)?.bubbles.length ?? 0} bubble`,
      );
    }
    for (const l of links) {
      console.log(
        `  ${l.bubble.legacy_id} -> ${l.panel?.panel_id ?? "unlinked"} (${l.how})`,
      );
    }
  }
  if (noPanels.length) {
    console.log(`Pages with no panels: ${noPanels.join(", ")}`);
  }

  if (!execute) {
    console.log("Dry run: nothing written. Pass --execute to write.");
    return;
  }

  if (force) {
    let del = supabase
      .from("panels")
      .delete()
      .eq("book_id", book)
      .eq("issue_id", issue);
    if (pages) del = del.in("page_number", runNumbers);
    const { error } = await del;
    if (error) fail(`--force delete: ${error.message}`);
  }

  for (const { pageNumber: n, parsed, panels, links } of plans) {
    if (panels.length === 0) continue;
    const { data: inserted, error: pErr } = await supabase
      .from("panels")
      .insert(panels)
      .select("id, panel_id");
    if (pErr) fail(`page ${n}: panels insert failed: ${pErr.message}`);
    const ids = new Map(
      (inserted as { id: string; panel_id: string }[]).map((r) => [
        r.panel_id,
        r.id,
      ]),
    );
    if (ids.size !== panels.length) {
      fail(`page ${n}: inserted ${ids.size} of ${panels.length} panels`);
    }

    const segRow = mapSegmentationRow(
      book,
      issue,
      n,
      parsed.image,
      parsed.segmentationPredictions,
    );
    const { error: sErr } = await supabase
      .from("page_segmentation")
      .upsert(segRow, { onConflict: "book_id,issue_id,page_number" });
    if (sErr)
      fail(`page ${n}: page_segmentation upsert failed: ${sErr.message}`);

    for (const { bubble, panel } of links) {
      if (!panel) continue;
      const { data, error } = await supabase
        .from("bubbles")
        .update({ panel_id: ids.get(panel.panel_id)! })
        .eq("book_id", book)
        .eq("issue_id", issue)
        .eq("id", bubble.id)
        .select("id");
      if (error || data?.length !== 1) {
        fail(
          `page ${n}: panel_id update on ${bubble.legacy_id} failed: ${error?.message ?? `${data?.length ?? 0} rows matched`}`,
        );
      }
    }
    console.log(
      `page ${n}: wrote ${panels.length} panels, page_segmentation, ${links.filter((l) => l.panel).length} bubble panel_ids`,
    );
  }

  const count = async (linked: boolean) => {
    const q = supabase
      .from("bubbles")
      .select("id", { count: "exact", head: true })
      .eq("book_id", book)
      .eq("issue_id", issue);
    const { count: c, error } = linked
      ? await q.not("panel_id", "is", null)
      : await q.is("panel_id", null);
    if (error) fail(`bubbles count: ${error.message}`);
    return c ?? 0;
  };
  console.log(
    `${book}/${issue}: ${await count(true)} bubbles with a panel_id, ${await count(false)} without`,
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

#!/usr/bin/env node

/**
 * Pipeline step: extract-foreground-masks
 *
 * Reads the SAM3 sidecars under data/sam3/ and produces panel-local
 * foreground polygon data under data/foreground/.
 *
 * Per-panel buckets:
 *   - characters: union of comic character / person / face / head polygons
 *                 whose centroid falls inside the panel's bbox
 *   - bubbles:    speech-bubble polygons assigned the same way
 *
 * Polygons are converted from page pixels → panel-local 0..1 and then
 * simplified with Ramer–Douglas–Peucker until each is ≤50 vertices, so
 * the persisted clip-path strings stay small (~1KB per polygon).
 *
 * Output sidecar shape (one file per page):
 *   {
 *     "image": { "width", "height" },
 *     "panels": [
 *       {
 *         "panel_index": 0,
 *         "panel_bbox_page": { "x", "y", "w", "h" },        // 0..1 page-space
 *         "foreground_polygons": {
 *           "characters": [ [[x,y], ...], ... ],            // panel-local 0..1
 *           "bubbles":    [ [[x,y], ...], ... ]
 *         }
 *       }
 *     ]
 *   }
 *
 * Resumable: skips pages whose foreground sidecar already exists, unless
 * --overwrite is passed.
 */

import fs from "fs-extra";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { glob } from "glob";
import {
  pointInBox,
  polygonCentroid,
  rdpSimplifyToBudget,
  rfBoxToTopLeftBox,
  toPanelLocal,
  toPageFrac,
  type BoxFrac,
  type BoxPx,
  type PointFrac,
  type PointPx,
} from "./utils/polygon-math.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

const FOREGROUND_CLASSES = new Set([
  "comic character",
  "person",
  "face",
  "head",
]);
const BUBBLE_CLASSES = new Set(["speech bubble"]);
const MAX_VERTS_PER_POLY = 50;

interface SAM3Polygon {
  class: string;
  confidence: number;
  points: PointPx[];
}

interface SAM3SidecarPanel {
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  detection_id: string;
}

interface SAM3Sidecar {
  image: { width: number; height: number };
  panel_predictions: SAM3SidecarPanel[];
  bubble_predictions: SAM3SidecarPanel[];
  segmentation_predictions: SAM3Polygon[];
}

interface PanelMaskOutput {
  panel_index: number;
  panel_bbox_page: BoxFrac;
  foreground_polygons: {
    characters: PointFrac[][];
    bubbles: PointFrac[][];
  };
}

interface ForegroundSidecar {
  image: { width: number; height: number };
  panels: PanelMaskOutput[];
}

function parseArgs(): { book: string; issue: string; overwrite: boolean } {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`
Usage: pnpm extract-foreground-masks -- --book <name> --issue <n> [--overwrite]
`);
    process.exit(0);
  }
  let book = process.env.COMIC_BOOK ?? "";
  let issue = process.env.COMIC_ISSUE ?? "";
  let overwrite = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a.startsWith("--book=")) book = a.split("=")[1]?.trim() ?? book;
    else if (a === "--book") book = argv[i + 1]?.trim() ?? book;
    else if (a.startsWith("--issue=")) {
      const v = a.split("=")[1]?.trim() ?? "";
      issue = v.startsWith("issue-") ? v : `issue-${v}`;
    } else if (a === "--issue") {
      const v = argv[i + 1]?.trim() ?? "";
      issue = v.startsWith("issue-") ? v : `issue-${v}`;
    } else if (a === "--overwrite") overwrite = true;
  }
  if (!book || !issue) {
    console.error("❌ --book and --issue are required");
    process.exit(1);
  }
  return { book, issue, overwrite };
}

function bucketPolygonByPanel(
  poly: SAM3Polygon,
  panels: BoxPx[],
): { panelIndex: number; bucket: "characters" | "bubbles" } | null {
  if (poly.points.length < 3) return null;
  const cls = poly.class;
  let bucket: "characters" | "bubbles";
  if (FOREGROUND_CLASSES.has(cls)) bucket = "characters";
  else if (BUBBLE_CLASSES.has(cls)) bucket = "bubbles";
  else return null;

  const c = polygonCentroid(poly.points);
  for (let i = 0; i < panels.length; i++) {
    const panel = panels[i];
    if (panel && pointInBox(c, panel)) {
      return { panelIndex: i, bucket };
    }
  }
  return null;
}

function processPage(sidecar: SAM3Sidecar): ForegroundSidecar {
  const panelsPx: BoxPx[] = sidecar.panel_predictions.map((p) =>
    rfBoxToTopLeftBox(p),
  );

  const buckets: { characters: SAM3Polygon[]; bubbles: SAM3Polygon[] }[] =
    panelsPx.map(() => ({ characters: [], bubbles: [] }));

  for (const poly of sidecar.segmentation_predictions) {
    const assignment = bucketPolygonByPanel(poly, panelsPx);
    if (!assignment) continue;
    const target = buckets[assignment.panelIndex];
    if (!target) continue;
    target[assignment.bucket].push(poly);
  }

  const panels: PanelMaskOutput[] = panelsPx.map((panel, idx) => {
    const bucket = buckets[idx] ?? { characters: [], bubbles: [] };
    return {
      panel_index: idx,
      panel_bbox_page: toPageFrac(
        panel,
        sidecar.image.width,
        sidecar.image.height,
      ),
      foreground_polygons: {
        characters: bucket.characters.map((p) =>
          simplifyForPanel(p.points, panel),
        ),
        bubbles: bucket.bubbles.map((p) => simplifyForPanel(p.points, panel)),
      },
    };
  });

  return { image: sidecar.image, panels };
}

function simplifyForPanel(points: PointPx[], panel: BoxPx): PointFrac[] {
  const local = points.map((p) => toPanelLocal(p, panel));
  return rdpSimplifyToBudget(local, MAX_VERTS_PER_POLY);
}

async function main() {
  const { book, issue, overwrite } = parseArgs();
  const ISSUE_DIR = join(PROJECT_ROOT, "assets", "comics", book, issue);
  const SAM3_DIR = join(ISSUE_DIR, "data", "sam3");
  const FG_DIR = join(ISSUE_DIR, "data", "foreground");

  if (!(await fs.pathExists(SAM3_DIR))) {
    console.error(
      `❌ SAM3 sidecars not found at ${SAM3_DIR} — run roboflow-page-analyze first.`,
    );
    process.exit(1);
  }

  await fs.ensureDir(FG_DIR);

  const sidecars = await glob("page-*.json", { cwd: SAM3_DIR });
  sidecars.sort();

  console.log(
    `\n🧩 Extracting foreground masks for ${sidecars.length} page(s) of ${book}/${issue}\n`,
  );

  let processed = 0;
  let skipped = 0;
  let totalChars = 0;
  let totalBubbles = 0;
  let totalPanels = 0;

  for (const filename of sidecars) {
    const fgPath = join(FG_DIR, filename);
    if (!overwrite && (await fs.pathExists(fgPath))) {
      skipped++;
      continue;
    }
    const sidecarPath = join(SAM3_DIR, filename);
    const raw = (await fs.readJSON(sidecarPath)) as SAM3Sidecar;
    const out = processPage(raw);
    await fs.writeJSON(fgPath, out, { spaces: 2 });

    let charCount = 0;
    let bubbleCount = 0;
    for (const p of out.panels) {
      charCount += p.foreground_polygons.characters.length;
      bubbleCount += p.foreground_polygons.bubbles.length;
    }
    totalChars += charCount;
    totalBubbles += bubbleCount;
    totalPanels += out.panels.length;

    const baseName = filename.replace(/\.json$/, "");
    console.log(
      `   ✓ ${baseName} → ${out.panels.length} panels, ${charCount} character poly(s), ${bubbleCount} bubble poly(s)`,
    );
    processed++;
  }

  console.log(
    `\n✅ Done. ${processed} processed${skipped > 0 ? `, ${skipped} skipped (already existed)` : ""}.`,
  );
  console.log(
    `   ${totalPanels} panels, ${totalChars} character polys, ${totalBubbles} bubble polys total → ${FG_DIR}\n`,
  );
}

main().catch((err) => {
  console.error("❌ extract-foreground-masks:", err);
  process.exit(1);
});

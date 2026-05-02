import fs from "fs-extra";
import sharp from "sharp";
import { join } from "path";
import { glob } from "glob";
import {
  polygonCentroid,
  pointInBox,
  rfBoxToTopLeftBox,
  type BoxPx,
  type PointPx,
} from "./polygon-math.js";
import { calculateIoU, type Box2D } from "./box-math.js";
import { applyPadding, clampBoxToBounds } from "./image-crop.js";

const FACE_CLASSES = new Set(["face", "head"]);
const MIN_CROP_PX = 20;
const FACE_PADDING = 0.15;

interface SAM3Polygon {
  class: string;
  confidence: number;
  points: PointPx[];
}

interface SAM3Sidecar {
  image: { width: number | null; height: number | null };
  panel_predictions: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
    confidence: number;
    detection_id: string;
  }>;
  segmentation_predictions: SAM3Polygon[];
}

export interface FaceCrop {
  pageNumber: number;
  panelIndex: number;
  bboxPx: Box2D;
  bboxPanelLocal: { x: number; y: number; w: number; h: number };
  cls: "face" | "head";
  confidence: number;
  imageBuffer: Buffer;
}

function polygonToBbox(points: PointPx[]): Box2D {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function deduplicateFaces(
  faces: Array<{
    bbox: Box2D;
    cls: string;
    confidence: number;
    points: PointPx[];
  }>,
): Array<{ bbox: Box2D; cls: string; confidence: number; points: PointPx[] }> {
  const kept: typeof faces = [];
  for (const f of faces) {
    let dominated = false;
    for (let i = 0; i < kept.length; i++) {
      const k = kept[i]!;
      if (calculateIoU(f.bbox, k.bbox) > 0.5) {
        if (f.cls === "face" && k.cls === "head") {
          kept[i] = f;
        } else if (f.cls === "head" && k.cls === "face") {
          // keep existing face
        } else if (f.confidence > k.confidence) {
          kept[i] = f;
        }
        dominated = true;
        break;
      }
    }
    if (!dominated) kept.push(f);
  }
  return kept;
}

async function extractCropsFromSidecar(
  sam3Dir: string,
  webpDir: string,
  pageNum: number,
): Promise<FaceCrop[]> {
  const padded = String(pageNum).padStart(2, "0");
  const sidecarPath = join(sam3Dir, `page-${padded}.json`);
  if (!(await fs.pathExists(sidecarPath))) return [];

  const sidecar = (await fs.readJSON(sidecarPath)) as SAM3Sidecar;
  if (sidecar.segmentation_predictions.length === 0) return [];

  const webpPath = join(webpDir, `page-${padded}.webp`);
  if (!(await fs.pathExists(webpPath))) return [];

  const imgBuf = await fs.readFile(webpPath);
  const meta = await sharp(imgBuf).metadata();
  const imgW = meta.width ?? sidecar.image.width ?? 0;
  const imgH = meta.height ?? sidecar.image.height ?? 0;
  if (imgW === 0 || imgH === 0) return [];

  const panelsPx: BoxPx[] = sidecar.panel_predictions.map((p) =>
    rfBoxToTopLeftBox(p),
  );

  const rawFaces = sidecar.segmentation_predictions
    .filter((p) => FACE_CLASSES.has(p.class) && p.points.length >= 3)
    .map((p) => ({
      bbox: polygonToBbox(p.points),
      cls: p.class,
      confidence: p.confidence,
      points: p.points,
    }));

  const faces = deduplicateFaces(rawFaces);
  const crops: FaceCrop[] = [];

  for (const face of faces) {
    if (face.bbox.width < MIN_CROP_PX || face.bbox.height < MIN_CROP_PX)
      continue;

    const centroid = polygonCentroid(face.points);
    let panelIndex = -1;
    for (let i = 0; i < panelsPx.length; i++) {
      if (pointInBox(centroid, panelsPx[i]!)) {
        panelIndex = i;
        break;
      }
    }
    if (panelIndex < 0) continue;

    const panel = panelsPx[panelIndex]!;
    const paddedBox = applyPadding(face.bbox, FACE_PADDING);
    const clampedBox = clampBoxToBounds(paddedBox, imgW, imgH);

    const cropped = await sharp(imgBuf)
      .extract({
        left: clampedBox.x,
        top: clampedBox.y,
        width: clampedBox.width,
        height: clampedBox.height,
      })
      .toBuffer();

    crops.push({
      pageNumber: pageNum,
      panelIndex,
      bboxPx: face.bbox,
      bboxPanelLocal: {
        x: (face.bbox.x - panel.x) / panel.w,
        y: (face.bbox.y - panel.y) / panel.h,
        w: face.bbox.width / panel.w,
        h: face.bbox.height / panel.h,
      },
      cls: face.cls as "face" | "head",
      confidence: face.confidence,
      imageBuffer: cropped,
    });
  }

  console.log(
    `   ✓ page-${padded}: ${faces.length} face/head detections → ${crops.length} crops`,
  );

  return crops;
}

export async function extractFaceCropsForPage(
  sam3Dir: string,
  webpDir: string,
  pageNum: number,
): Promise<FaceCrop[]> {
  return extractCropsFromSidecar(sam3Dir, webpDir, pageNum);
}

export async function extractFaceCrops(
  sam3Dir: string,
  webpDir: string,
): Promise<FaceCrop[]> {
  const sidecars = await glob("page-*.json", { cwd: sam3Dir });
  sidecars.sort();
  const crops: FaceCrop[] = [];

  for (const filename of sidecars) {
    const pageNum = parseInt(
      filename.replace("page-", "").replace(".json", ""),
      10,
    );
    const pageCrops = await extractCropsFromSidecar(sam3Dir, webpDir, pageNum);
    crops.push(...pageCrops);
  }

  return crops;
}

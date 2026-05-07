import sharp from "sharp";

const FACE_CLASSES = new Set(["face", "head"]);
const MIN_CROP_PX = 20;
const FACE_PADDING = 0.15;

export interface Box2D {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FaceCropResult {
  panelId: string;
  bboxPx: Box2D;
  bboxPanelLocal: { x: number; y: number; w: number; h: number };
  cls: "face" | "head";
  confidence: number;
  webpBuffer: Buffer;
  jpegBuffer: Buffer;
}

export interface SegmentationPrediction {
  class: string;
  confidence: number;
  points: Array<{ x: number; y: number }>;
}

export interface PanelRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function polygonToBbox(points: Array<{ x: number; y: number }>): Box2D {
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

function calculateIoU(box1: Box2D, box2: Box2D): number {
  const x1 = Math.max(box1.x, box2.x);
  const y1 = Math.max(box1.y, box2.y);
  const x2 = Math.min(box1.x + box1.width, box2.x + box2.width);
  const y2 = Math.min(box1.y + box1.height, box2.y + box2.height);
  if (x2 < x1 || y2 < y1) return 0;
  const intersection = (x2 - x1) * (y2 - y1);
  const area1 = box1.width * box1.height;
  const area2 = box2.width * box2.height;
  const union = area1 + area2 - intersection;
  return union > 0 ? intersection / union : 0;
}

interface RawFace {
  bbox: Box2D;
  cls: string;
  confidence: number;
  points: Array<{ x: number; y: number }>;
}

function deduplicateFaces(faces: RawFace[]): RawFace[] {
  const kept: RawFace[] = [];
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

function applyPadding(box: Box2D, padding: number): Box2D {
  return {
    x: Math.max(0, Math.floor(box.x - box.width * padding)),
    y: Math.max(0, Math.floor(box.y - box.height * padding)),
    width: Math.max(1, Math.floor(box.width * (1 + padding * 2))),
    height: Math.max(1, Math.floor(box.height * (1 + padding * 2))),
  };
}

function clampBox(box: Box2D, maxW: number, maxH: number): Box2D {
  const x = Math.max(0, Math.min(box.x, maxW - 1));
  const y = Math.max(0, Math.min(box.y, maxH - 1));
  return {
    x,
    y,
    width: Math.max(1, Math.min(box.width, maxW - x)),
    height: Math.max(1, Math.min(box.height, maxH - y)),
  };
}

export async function extractFaceCropsFromBuffer(
  imgBuf: Buffer,
  predictions: SegmentationPrediction[],
  panels: PanelRect[],
): Promise<FaceCropResult[]> {
  const meta = await sharp(imgBuf).metadata();
  const imgW = meta.width ?? 0;
  const imgH = meta.height ?? 0;
  if (imgW === 0 || imgH === 0) return [];

  const rawFaces = predictions
    .filter((p) => FACE_CLASSES.has(p.class) && p.points.length >= 3)
    .map((p) => ({
      bbox: polygonToBbox(p.points),
      cls: p.class,
      confidence: p.confidence,
      points: p.points,
    }));

  const faces = deduplicateFaces(rawFaces);
  const crops: FaceCropResult[] = [];

  for (const face of faces) {
    if (face.bbox.width < MIN_CROP_PX || face.bbox.height < MIN_CROP_PX)
      continue;

    const cx = face.bbox.x + face.bbox.width / 2;
    const cy = face.bbox.y + face.bbox.height / 2;
    const panel = panels.find(
      (p) => cx >= p.x && cx <= p.x + p.w && cy >= p.y && cy <= p.y + p.h,
    );
    if (!panel) continue;

    const paddedBox = applyPadding(face.bbox, FACE_PADDING);
    const clampedBox = clampBox(paddedBox, imgW, imgH);

    const extracted = sharp(imgBuf).extract({
      left: clampedBox.x,
      top: clampedBox.y,
      width: clampedBox.width,
      height: clampedBox.height,
    });

    let webpBuffer: Buffer;
    let jpegBuffer: Buffer;
    try {
      [webpBuffer, jpegBuffer] = await Promise.all([
        extracted.clone().toBuffer(),
        extracted.clone().jpeg({ quality: 85 }).toBuffer(),
      ]);
    } catch {
      continue;
    }

    crops.push({
      panelId: panel.id,
      bboxPx: face.bbox,
      bboxPanelLocal: {
        x: (face.bbox.x - panel.x) / panel.w,
        y: (face.bbox.y - panel.y) / panel.h,
        w: face.bbox.width / panel.w,
        h: face.bbox.height / panel.h,
      },
      cls: face.cls as "face" | "head",
      confidence: face.confidence,
      webpBuffer,
      jpegBuffer,
    });
  }

  return crops;
}

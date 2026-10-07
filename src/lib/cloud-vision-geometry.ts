import { createHash } from "node:crypto";
import { isDryRun } from "./fakes/dry-run";
import type { Box, TextGeometry } from "~/types/text-geometry";

/**
 * Word boxes for one page from Google Cloud Vision `DOCUMENT_TEXT_DETECTION`
 * (#572), as page-level `TextGeometry` for `assignLinesToBubbles`. Takes the
 * page's image bytes; downloading the page is the caller's job.
 */

export const CLOUD_VISION_ENGINE = "cloud-vision@v1";

const ENDPOINT = "https://vision.googleapis.com/v1/images:annotate";
const LINE_END = new Set(["LINE_BREAK", "EOL_SURE_SPACE", "HYPHEN"]);

type Vertex = { x?: number; y?: number };
type Word = {
  boundingBox: { vertices: Vertex[] };
  symbols: {
    text: string;
    property?: { detectedBreak?: { type?: string } };
  }[];
  confidence?: number;
};
type Annotation = {
  pages: {
    width: number;
    height: number;
    blocks: { paragraphs: { words: Word[] }[] }[];
  }[];
};
type Line = TextGeometry["lines"][number];

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

/** A vertex may omit `x` or `y`, meaning 0. */
function toBox(vertices: Vertex[], w: number, h: number): Box {
  const xs = vertices.map((v) => v.x ?? 0);
  const ys = vertices.map((v) => v.y ?? 0);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return [
    r4(x0 / w),
    r4(y0 / h),
    r4((Math.max(...xs) - x0) / w),
    r4((Math.max(...ys) - y0) / h),
  ];
}

function union(boxes: Box[]): Box {
  const x0 = Math.min(...boxes.map((b) => b[0]));
  const y0 = Math.min(...boxes.map((b) => b[1]));
  const x1 = Math.max(...boxes.map((b) => b[0] + b[2]));
  const y1 = Math.max(...boxes.map((b) => b[1] + b[3]));
  return [r4(x0), r4(y0), r4(x1 - x0), r4(y1 - y0)];
}

/**
 * Words in reading order, split into lines after a word whose last symbol
 * breaks the line (and at every paragraph end); a line's box is the union of
 * its word boxes.
 */
function toGeometry(annotation: Annotation | undefined, sha: string) {
  const page = annotation?.pages[0];
  const lines: Line[] = [];
  for (const block of page?.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      let words: Line["words"] = [];
      const flush = () => {
        if (words.length)
          lines.push({ box: union(words.map((w) => w.box)), words });
        words = [];
      };
      for (const word of paragraph.words) {
        words.push({
          t: word.symbols.map((s) => s.text).join(""),
          box: toBox(word.boundingBox.vertices, page!.width, page!.height),
          conf: r4(word.confidence ?? 0),
        });
        const brk = word.symbols.at(-1)?.property?.detectedBreak?.type;
        if (brk && LINE_END.has(brk)) flush();
      }
      flush();
    }
  }
  return {
    engine: CLOUD_VISION_ENGINE,
    image: { w: page?.width ?? 0, h: page?.height ?? 0, sha },
    lines,
  } satisfies TextGeometry;
}

/**
 * OCR one page image. Under DRY_RUN it reads no key, calls no `fetch` and
 * returns a geometry with no lines. Throws when `GOOGLE_CLOUD_VISION_API_KEY`
 * is missing or the API returns an error.
 */
export async function cloudVisionGeometry(
  image: Uint8Array,
): Promise<TextGeometry> {
  const sha = createHash("sha256").update(image).digest("hex");
  if (isDryRun()) return toGeometry(undefined, sha);

  const { env } = await import("~/env.mjs");
  const key = env.GOOGLE_CLOUD_VISION_API_KEY;
  if (!key) throw new Error("GOOGLE_CLOUD_VISION_API_KEY is not set");

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      requests: [
        {
          image: { content: Buffer.from(image).toString("base64") },
          features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
          imageContext: { languageHints: ["en"] },
        },
      ],
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    responses?: {
      fullTextAnnotation?: Annotation;
      error?: { message?: string };
    }[];
    error?: { message?: string };
  };
  if (!res.ok || body.error) {
    throw new Error(
      `Cloud Vision HTTP ${res.status}: ${body.error?.message ?? res.statusText}`,
    );
  }
  const response = body.responses?.[0];
  if (response?.error) {
    throw new Error(`Cloud Vision: ${response.error.message}`);
  }
  return toGeometry(response?.fullTextAnnotation, sha);
}

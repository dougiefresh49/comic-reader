import type { Json, TablesInsert, TablesUpdate } from "~/types/database";
import type {
  PanelAudioTags,
  PanelBoundingBox,
  PanelForegroundPolygons,
  PanelLocalPolygon,
} from "~/types/panels";
import type { RoleId } from "~/lib/cast";
import { slugify } from "~/lib/character-id";

export type RoboflowBoxPrediction = {
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  class?: string;
  detection_id?: string;
};

export type RoboflowSegPrediction = {
  class: string;
  confidence: number;
  detection_id?: string;
  parent_id?: string;
  points: Array<{ x: number; y: number }>;
  [key: string]: unknown;
};

export type ContextParsed = {
  type?: string;
  speaker?: string | null;
  emotion?: string;
  characterType?: string;
  side?: string;
  voiceDescription?: string;
  textWithCues?: string;
};

/** A page with no panels reports a null panel image size (#221). */
type RoboflowImageSize = { width: number | null; height: number | null };

/** Shape of one SAM3 workflow `outputs[0]` entry before validation. */
export type RoboflowSam3Output = {
  panel_predictions?: {
    image?: RoboflowImageSize;
    predictions?: RoboflowBoxPrediction[];
  };
  bubble_predictions?: {
    image?: RoboflowImageSize;
    predictions?: RoboflowBoxPrediction[];
  };
  segmentation_predictions?: {
    image?: RoboflowImageSize;
    predictions?: RoboflowSegPrediction[];
  };
};

/** Validated SAM3 predictions ready for the row mappers. */
export type ParsedRoboflowSam3 = {
  panelPredictions: RoboflowBoxPrediction[];
  image: { width: number; height: number };
  bubblePredictions: RoboflowBoxPrediction[];
  segmentationPredictions: RoboflowSegPrediction[];
};

function imageSize(
  image: RoboflowImageSize | undefined,
): { width: number; height: number } | null {
  return typeof image?.width === "number" && typeof image.height === "number"
    ? { width: image.width, height: image.height }
    : null;
}

/**
 * Parse a SAM3 workflow output. Returns null when any required
 * predictions object is missing, its predictions value is not an array, or
 * no image size can be read. Present empty arrays are valid. The image size
 * is the panel image's; only when there are no panel boxes, whose pixels it
 * would measure, may it come from the bubble or segmentation image instead
 * (#221: a page with no panels reports a null panel image size).
 */
export function parseRoboflowSam3Output(
  out: RoboflowSam3Output | null | undefined,
): ParsedRoboflowSam3 | null {
  const panelPreds = out?.panel_predictions?.predictions;
  const bubblePreds = out?.bubble_predictions?.predictions;
  const segPreds = out?.segmentation_predictions?.predictions;

  if (
    !out?.panel_predictions ||
    !Array.isArray(panelPreds) ||
    !out.bubble_predictions ||
    !Array.isArray(bubblePreds) ||
    !out.segmentation_predictions ||
    !Array.isArray(segPreds)
  ) {
    return null;
  }

  const image =
    imageSize(out.panel_predictions.image) ??
    (panelPreds.length === 0
      ? (imageSize(out.bubble_predictions.image) ??
        imageSize(out.segmentation_predictions.image))
      : null);
  if (!image) return null;

  return {
    panelPredictions: panelPreds,
    image,
    bubblePredictions: bubblePreds,
    segmentationPredictions: segPreds,
  };
}

/** Audio direction for a panel nobody has directed yet. */
export const DEFAULT_PANEL_AUDIO_TAGS: PanelAudioTags = {
  ambience: [],
  sfx: [],
  music_mood: "transition_neutral",
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/**
 * Turn a stored `panels.audio_tags` value into a complete PanelAudioTags.
 * The column default is `{}`, and a panel row holding it 500'd the reader
 * (#222), so each field is checked on its own: a field with the right type
 * is kept, a missing or wrong-typed one comes from the default. A fallback
 * array is a copy, so callers never share the default's own arrays.
 */
export function normalizePanelAudioTags(value: unknown): PanelAudioTags {
  const tags =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    ambience: isStringArray(tags.ambience)
      ? tags.ambience
      : [...DEFAULT_PANEL_AUDIO_TAGS.ambience],
    sfx: isStringArray(tags.sfx) ? tags.sfx : [...DEFAULT_PANEL_AUDIO_TAGS.sfx],
    music_mood:
      typeof tags.music_mood === "string"
        ? tags.music_mood
        : DEFAULT_PANEL_AUDIO_TAGS.music_mood,
  };
}

/** Map Roboflow panel centre-pixel boxes to `panels` insert rows. */
export function mapPanelRows(
  bookId: string,
  issueId: string,
  pageNumber: number,
  predictions: RoboflowBoxPrediction[],
  imgDims: { width: number; height: number },
): TablesInsert<"panels">[] {
  const padded = String(pageNumber).padStart(2, "0");
  return predictions.map((p, idx) => ({
    book_id: bookId,
    issue_id: issueId,
    page_number: pageNumber,
    panel_id: `p${padded}-${String(idx + 1).padStart(2, "0")}`,
    sort_order: idx,
    source: "roboflow",
    bounding_box: {
      x: (p.x - p.width / 2) / imgDims.width,
      y: (p.y - p.height / 2) / imgDims.height,
      w: p.width / imgDims.width,
      h: p.height / imgDims.height,
    },
    // Write a complete value, not the column default `{}` (#222). The spread
    // makes a plain object, which Json accepts and an interface is not.
    audio_tags: { ...normalizePanelAudioTags(null) },
  }));
}

/**
 * Map Roboflow bubble centre-pixel boxes to `bubbles` insert rows.
 * Detection confidence lives inside `box_2d`, not as a top-level column.
 */
export function mapBubbleRows(
  bookId: string,
  issueId: string,
  pageNumber: number,
  predictions: RoboflowBoxPrediction[],
): TablesInsert<"bubbles">[] {
  const padded = String(pageNumber).padStart(2, "0");
  return predictions.map((b, idx) => ({
    book_id: bookId,
    issue_id: issueId,
    page_number: pageNumber,
    legacy_id: `page-${padded}_b${String(idx + 1).padStart(2, "0")}`,
    sort_order: idx,
    box_2d: {
      x: Math.round(b.x - b.width / 2),
      y: Math.round(b.y - b.height / 2),
      width: Math.round(b.width),
      height: Math.round(b.height),
      confidence: b.confidence,
    },
  }));
}

/** Map SAM3 predictions to a single `page_segmentation` insert row. */
export function mapSegmentationRow(
  bookId: string,
  issueId: string,
  pageNumber: number,
  imgDims: { width: number; height: number },
  predictions: RoboflowSegPrediction[],
): TablesInsert<"page_segmentation"> {
  return {
    book_id: bookId,
    issue_id: issueId,
    page_number: pageNumber,
    image_width: imgDims.width,
    image_height: imgDims.height,
    predictions: predictions as unknown as Json,
  };
}

/** The one thing the foreground mapping reads off a panel row. */
export type ForegroundPanel = { bounding_box: PanelBoundingBox };

/** A segmentation prediction, as `page_segmentation.predictions` stores it. */
export type ForegroundPrediction = {
  class: string;
  points: Array<{ x: number; y: number }>;
};

/** At most this many vertices survive per polygon, so rows stay small. */
const MAX_POLY_VERTS = 50;

const CHARACTER_CLASSES = new Set([
  "comic character",
  "person",
  "face",
  "head",
]);
const BUBBLE_CLASSES = new Set(["speech bubble"]);

/**
 * Ramer-Douglas-Peucker, moved here from `shared.ts` with the foreground
 * mapping (#219). It is pure, and this module is imported by the reader's
 * server code, which must not pull `shared.ts`'s `workflow` and client
 * imports in with it. `shared.ts` re-exports it for its other callers.
 */
export function rdpSimplify(
  points: Array<{ x: number; y: number }>,
  epsilon: number,
): Array<{ x: number; y: number }> {
  if (points.length <= 2) return points;

  let maxDist = 0;
  let maxIdx = 0;
  const first = points[0]!;
  const last = points[points.length - 1]!;

  for (let i = 1; i < points.length - 1; i++) {
    const pt = points[i]!;
    const dist = perpendicularDist(pt, first, last);
    if (dist > maxDist) {
      maxDist = dist;
      maxIdx = i;
    }
  }

  if (maxDist > epsilon) {
    const left = rdpSimplify(points.slice(0, maxIdx + 1), epsilon);
    const right = rdpSimplify(points.slice(maxIdx), epsilon);
    return [...left.slice(0, -1), ...right];
  }

  return [first, last];
}

function perpendicularDist(
  pt: { x: number; y: number },
  lineStart: { x: number; y: number },
  lineEnd: { x: number; y: number },
): number {
  const dx = lineEnd.x - lineStart.x;
  const dy = lineEnd.y - lineStart.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ex = pt.x - lineStart.x;
    const ey = pt.y - lineStart.y;
    return Math.sqrt(ex * ex + ey * ey);
  }
  const num = Math.abs(
    dy * pt.x - dx * pt.y + lineEnd.x * lineStart.y - lineEnd.y * lineStart.x,
  );
  return num / Math.sqrt(lenSq);
}

/** Rasterised masks come back with hundreds of vertices; thin them out. */
function simplifyPoly(points: PanelLocalPolygon): PanelLocalPolygon {
  if (points.length <= MAX_POLY_VERTS) return points;
  let simplified = points;
  let eps = 0.005;
  while (simplified.length > MAX_POLY_VERTS && eps < 0.1) {
    simplified = rdpSimplify(points, eps);
    eps *= 1.5;
  }
  return simplified;
}

/**
 * Map SAM3 segmentation predictions to per-panel foreground polygons in
 * panel-local coordinates, relative to the panel's own box and unclamped:
 * a polygon reaching past the panel edge comes back outside 0..1 (#219). One
 * polygon goes to the first panel
 * holding its centroid, in the order `panels` is passed, and a panel with
 * nothing in it gets empty lists: writing `foreground_polygons` is the
 * caller's call, not this function's. Pure: no client, no fetch, no writes.
 */
export function mapForegroundPolygons(
  panels: ForegroundPanel[],
  image: { width: number; height: number },
  predictions: ForegroundPrediction[],
): PanelForegroundPolygons[] {
  const { width: imgW, height: imgH } = image;
  const panelsPx = panels.map((p) => ({
    x: p.bounding_box.x * imgW,
    y: p.bounding_box.y * imgH,
    w: p.bounding_box.w * imgW,
    h: p.bounding_box.h * imgH,
  }));

  const polys: PanelForegroundPolygons[] = panelsPx.map(() => ({
    characters: [],
    bubbles: [],
  }));

  for (const pred of predictions) {
    const isChar = CHARACTER_CLASSES.has(pred.class);
    const isBubble = BUBBLE_CLASSES.has(pred.class);
    if (!isChar && !isBubble) continue;
    if (pred.points.length < 3) continue;

    const cx = pred.points.reduce((s, pt) => s + pt.x, 0) / pred.points.length;
    const cy = pred.points.reduce((s, pt) => s + pt.y, 0) / pred.points.length;

    const i = panelsPx.findIndex(
      (panel) =>
        cx >= panel.x &&
        cx <= panel.x + panel.w &&
        cy >= panel.y &&
        cy <= panel.y + panel.h,
    );
    if (i < 0) continue;

    const panel = panelsPx[i]!;
    const local: PanelLocalPolygon = pred.points.map((pt) => ({
      x: (pt.x - panel.x) / panel.w,
      y: (pt.y - panel.y) / panel.h,
    }));
    polys[i]![isChar ? "characters" : "bubbles"].push(simplifyPoly(local));
  }

  return polys;
}

/** Fields used to decide whether a bubble already has reviewed/context data. */
export type BubbleContextFields = {
  ocr_text: string | null;
  text_with_cues: string | null;
  speaker: string | null;
  ignored: boolean | null;
};

/**
 * True when a bubble already has context and must not be overwritten.
 * Any of ocr_text, text_with_cues, speaker non-null, or ignored true.
 */
export function bubbleHasContext(bubble: BubbleContextFields): boolean {
  return (
    bubble.ocr_text != null ||
    bubble.text_with_cues != null ||
    bubble.speaker != null ||
    bubble.ignored === true
  );
}

/**
 * One member of the closed cast get-context chooses the speaker from (#354):
 * a `characters` row the issue's castlist holds, or one of the three roles.
 * The step builds them from the issue's castlist rows and the book's
 * `characters` rows; the bench script (branch `issue-354-bench`, not merged)
 * builds them from `proposeCast`.
 */
export type ClosedCastMember = {
  /** The `characters.id`; what `bubbles.character_id` gets on a match. */
  id: string;
  /** The display name; what `bubbles.speaker` gets on a match. */
  name: string;
  /** Every other name the character goes by, from `characters.aliases`. */
  aliases: string[];
};

/** The marker a cast line carries when a face on the page was identified as that member. */
export const SEEN_ON_PAGE = "[seen on this page]";

/**
 * What the prompt says a cast line means. Goes under the cast heading as
 * `castNotes`, so the list and its legend stay in step here, not in the
 * prompt builder.
 */
export const CLOSED_CAST_NOTES = `Each line is one cast member: the name first, then "(also called ...)" with the other names they go by, then "${SEEN_ON_PAGE}" when a face on this page was identified as them. A member without that mark can still be the speaker, with their face unrecognized or speaking from outside the panel, and is still named as that member. Give the name at the start of the line, with nothing from the parentheses or brackets.`;

/**
 * The cast as the get-context prompt lists it, one line per member in the
 * order given: the display name, "(also called ...)" when the member has
 * aliases that are not the name itself, and `SEEN_ON_PAGE` when `seenIds`
 * holds the member's id. Pure: the bench renders the same lines the step sends.
 */
export function closedCastLines(
  cast: ClosedCastMember[],
  seenIds: Iterable<string>,
): string[] {
  const seen = new Set(seenIds);
  return cast.map((m) => castLine(m, seen.has(m.id)));
}

/** One member's cast line; the only place the two notes are written. */
function castLine(m: ClosedCastMember, seen: boolean): string {
  const nameKey = slugify(m.name);
  const aliases = m.aliases.filter((a) => {
    const key = slugify(a);
    return key !== "" && key !== nameKey && key !== m.id;
  });
  const parts = [m.name];
  if (aliases.length > 0) parts.push(`(also called ${aliases.join(", ")})`);
  if (seen) parts.push(SEEN_ON_PAGE);
  return parts.join(" ");
}

/**
 * The cast member a reply names, or null when it names nobody on the list.
 * Exact after `slugify`, the review editor's `findCast` rule: the id, the
 * display name, or a whole alias, ids winning over names and names over
 * aliases. When that finds nobody, a reply that copied a member's cast line
 * is that member: the line as `closedCastLines` writes it, with or without
 * `SEEN_ON_PAGE`, or the name with `SEEN_ON_PAGE` alone (#373, decisions row
 * 269). The reply is compared whole and never cut: never an alias's first
 * word, never a fuzzy match. A reply the cast does not hold is stored as null
 * for review, not guessed (#354).
 */
export function matchCastSpeaker(
  raw: string | null | undefined,
  cast: ClosedCastMember[],
): ClosedCastMember | null {
  if (typeof raw !== "string") return null;
  const key = slugify(raw);
  if (!key) return null;
  return (
    cast.find((m) => m.id === key || slugify(m.name) === key) ??
    cast.find((m) => m.aliases.some((a) => slugify(a) === key)) ??
    cast.find((m) => copiedCastLineKeys(m).includes(key)) ??
    null
  );
}

/** The slugs of a member's cast line as a reply can copy it: with and without each note. */
function copiedCastLineKeys(m: ClosedCastMember): string[] {
  return [
    castLine(m, false),
    castLine(m, true),
    `${m.name} ${SEEN_ON_PAGE}`,
  ].map(slugify);
}

/** The narrator role's `characters.id`; NARRATION and CAPTION resolve to it through the match. */
const NARRATOR_ID: RoleId = "narrator";

/**
 * The name a reply gives for the speaker, before matching: the narrator role
 * for NARRATION and CAPTION, else `speaker` as written (null when absent).
 */
export function contextSpeakerReply(parsed: ContextParsed): string | null {
  const bubbleType = parsed.type ?? "SPEECH";
  if (bubbleType === "NARRATION" || bubbleType === "CAPTION") {
    return NARRATOR_ID;
  }
  return typeof parsed.speaker === "string" ? parsed.speaker : null;
}

/**
 * Build the `bubbles` update for OCR + speaker/emotion context.
 * `text_with_cues` is the text column; there is no `text` column.
 * The speaker is `contextSpeakerReply` matched against `cast`: a match writes
 * the member's id to `character_id` and its display name to `speaker`; no
 * match writes null to both, which the review editor flags (#354).
 */
export function buildContextUpdate(
  parsed: ContextParsed,
  ocrText: string,
  aiReasoning: string | null,
  cast: ClosedCastMember[],
): TablesUpdate<"bubbles"> {
  const bubbleType = parsed.type ?? "SPEECH";
  const match = matchCastSpeaker(contextSpeakerReply(parsed), cast);

  return {
    ocr_text: ocrText,
    type: bubbleType,
    speaker: match?.name ?? null,
    character_id: match?.id ?? null,
    emotion: parsed.emotion ?? "neutral",
    character_type: parsed.characterType ?? null,
    side: parsed.side ?? null,
    voice_description: parsed.voiceDescription ?? null,
    text_with_cues: parsed.textWithCues ?? ocrText,
    ai_reasoning: aiReasoning,
    ignored: bubbleType === "SFX" || bubbleType === "BACKGROUND",
  };
}

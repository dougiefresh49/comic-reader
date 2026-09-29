import type { Json, TablesInsert, TablesUpdate } from "~/types/database";
import type { PanelAudioTags } from "~/types/panels";

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

/** Shape of one SAM3 workflow `outputs[0]` entry before validation. */
export type RoboflowSam3Output = {
  panel_predictions?: {
    image?: { width: number; height: number };
    predictions?: RoboflowBoxPrediction[];
  };
  bubble_predictions?: {
    predictions?: RoboflowBoxPrediction[];
  };
  segmentation_predictions?: {
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

/**
 * Parse a SAM3 workflow output. Returns null when any required
 * predictions object is missing or its predictions value is not an array.
 * Present empty arrays are valid.
 */
export function parseRoboflowSam3Output(
  out: RoboflowSam3Output | null | undefined,
): ParsedRoboflowSam3 | null {
  const panelPreds = out?.panel_predictions?.predictions;
  const imgDims = out?.panel_predictions?.image;
  const bubblePreds = out?.bubble_predictions?.predictions;
  const segPreds = out?.segmentation_predictions?.predictions;

  if (
    !out?.panel_predictions ||
    !imgDims ||
    typeof imgDims.width !== "number" ||
    typeof imgDims.height !== "number" ||
    !Array.isArray(panelPreds) ||
    !out.bubble_predictions ||
    !Array.isArray(bubblePreds) ||
    !out.segmentation_predictions ||
    !Array.isArray(segPreds)
  ) {
    return null;
  }

  return {
    panelPredictions: panelPreds,
    image: imgDims,
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
 * Build the `bubbles` update for OCR + speaker/emotion context.
 * `text_with_cues` is the text column; there is no `text` column.
 */
export function buildContextUpdate(
  parsed: ContextParsed,
  ocrText: string,
  aiReasoning: string | null,
): TablesUpdate<"bubbles"> {
  const bubbleType = parsed.type ?? "SPEECH";
  const speaker =
    bubbleType === "NARRATION" || bubbleType === "CAPTION"
      ? "Narrator"
      : (parsed.speaker ?? null);

  return {
    ocr_text: ocrText,
    type: bubbleType,
    speaker,
    emotion: parsed.emotion ?? "neutral",
    character_type: parsed.characterType ?? null,
    side: parsed.side ?? null,
    voice_description: parsed.voiceDescription ?? null,
    text_with_cues: parsed.textWithCues ?? ocrText,
    ai_reasoning: aiReasoning,
    ignored: bubbleType === "SFX" || bubbleType === "BACKGROUND",
  };
}

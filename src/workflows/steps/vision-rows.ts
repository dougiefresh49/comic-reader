import type { Json, TablesInsert, TablesUpdate } from "~/types/database";

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

import {
  GoogleGenAI,
  createPartFromBase64,
  createPartFromText,
} from "@google/genai";
import sharp from "sharp";
import { GEMINI_MEDIUM } from "~/lib/models";

type BoundingBoxJson = { x: number; y: number; w: number; h: number };

interface SortPanelRow {
  id: string;
  panel_id: string;
  page_number: number;
  sort_order: number;
  bounding_box: BoundingBoxJson;
}

interface SortBubbleRow {
  id: string;
  legacy_id: string | null;
  panel_id: string | null;
  sort_order: number;
  ocr_text: string | null;
  text_with_cues: string | null;
  ignored: boolean;
  box_2d: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  } | null;
  style: Record<string, string> | null;
}

interface GeminiPanelSortEntry {
  panelId: string;
  sortOrder: number;
  bubbles: Array<{ bubbleId: string; sortOrder: number }>;
}

interface GeminiSortResponse {
  panels: GeminiPanelSortEntry[];
}

function extractJsonObject(text: string): string {
  let jsonText = text.trim();
  const jsonMatch = /```json\s*([\s\S]*?)\s*```/.exec(jsonText);
  if (jsonMatch?.[1]) {
    jsonText = jsonMatch[1].trim();
  } else {
    const codeMatch = /```\s*([\s\S]*?)\s*```/.exec(jsonText);
    if (codeMatch?.[1]) jsonText = codeMatch[1].trim();
  }
  const objectMatch = /\{[\s\S]*\}/.exec(jsonText);
  return objectMatch?.[0] ?? jsonText;
}

function bubbleSnippet(b: SortBubbleRow): string {
  const t = (b.text_with_cues ?? b.ocr_text ?? "").trim();
  return t.length > 120 ? `${t.slice(0, 117)}...` : t;
}

function bubbleLayoutLine(
  b: SortBubbleRow,
  imgW: number,
  imgH: number,
): string {
  let x = b.box_2d?.x ?? 0;
  let y = b.box_2d?.y ?? 0;
  let w = b.box_2d?.width ?? 0;
  let h = b.box_2d?.height ?? 0;
  if (
    x === 0 &&
    y === 0 &&
    w === 0 &&
    h === 0 &&
    b.style &&
    imgW > 0 &&
    imgH > 0
  ) {
    const pct = (s: string | undefined) => parseFloat(s ?? "0") / 100;
    x = Math.floor(pct(b.style.left) * imgW);
    y = Math.floor(pct(b.style.top) * imgH);
    w = Math.max(1, Math.floor(pct(b.style.width) * imgW));
    h = Math.max(1, Math.floor(pct(b.style.height) * imgH));
  }
  const nx = imgW > 0 ? x / imgW : 0;
  const ny = imgH > 0 ? y / imgH : 0;
  const nw = imgW > 0 ? w / imgW : 0;
  const nh = imgH > 0 ? h / imgH : 0;
  const panelHint = b.panel_id ?? "none";
  return `- bubbleId: ${b.id}\n  assigned_panel_uuid: ${panelHint}\n  bbox_normalized: x=${nx.toFixed(4)}, y=${ny.toFixed(4)}, w=${nw.toFixed(4)}, h=${nh.toFixed(4)}\n  text: "${bubbleSnippet(b).replace(/"/g, '\\"')}"\n  ignored: ${b.ignored}`;
}

async function getSortPlanFromGemini(
  gemini: GoogleGenAI,
  pageImage: Buffer,
  imgW: number,
  imgH: number,
  panels: SortPanelRow[],
  bubbles: SortBubbleRow[],
): Promise<GeminiSortResponse> {
  const panelLines = panels
    .map((p) => {
      const bb = p.bounding_box;
      return `- panelId (uuid): ${p.id}\n  human_panel_id: ${p.panel_id}\n  current_sort_order: ${p.sort_order}\n  bbox_normalized: x=${bb.x}, y=${bb.y}, w=${bb.w}, h=${bb.h}`;
    })
    .join("\n");

  const bubbleLines = bubbles.map((b) => bubbleLayoutLine(b, imgW, imgH));

  const prompt = `You are analyzing a comic book page image.

**Task:** Determine:
1. The correct READING ORDER of **panels** on this page (Western comics: mostly top-to-bottom rows, left-to-right within a row; manga may use right-to-left columns — follow what the layout implies).
2. Within EACH panel, the correct reading order of **speech bubbles / captions** (follow tails, narrative flow, and spatial cues).

**Panel records (bbox x,y,w,h are fractions of page width/height, origin top-left):**
${panelLines || "(no panels)"}

**Bubble records:**
${bubbleLines.join("\n") || "(no bubbles)"}

**Rules:**
- Use each panel's **panelId** exactly as given — it is the database UUID string.
- Use each bubble's **bubbleId** exactly as given — it is the database UUID string.
- Include EVERY panel id exactly once in your output.
- Include EVERY bubble id exactly once inside the \`bubbles\` array of exactly one panel (the panel where the bubble visually belongs). If unsure, pick the panel whose bbox contains the bubble center.
- Bubbles with ignored=true should still be listed in reading order (they remain in the narrative layout).

**Output — JSON only (no markdown fences):**
{
  "panels": [
    {
      "panelId": "<panel uuid>",
      "sortOrder": 0,
      "bubbles": [
        { "bubbleId": "<bubble uuid>", "sortOrder": 0 }
      ]
    }
  ]
}

- \`panels[].sortOrder\`: 0-based order for panels across the page.
- \`bubbles[].sortOrder\`: 0-based order within that panel only.
`;

  const imagePart = createPartFromBase64(
    pageImage.toString("base64"),
    "image/webp",
  );
  const textPart = createPartFromText(prompt);

  const response = await gemini.models.generateContent({
    model: GEMINI_MEDIUM,
    contents: [imagePart, textPart],
  });

  const text = response.text;
  if (!text) throw new Error("No text response from Gemini");

  const jsonText = extractJsonObject(text);
  const parsed = JSON.parse(jsonText) as GeminiSortResponse;
  if (!parsed.panels || !Array.isArray(parsed.panels)) {
    throw new Error("Invalid response: missing panels array");
  }
  return parsed;
}

function validateAndFlattenOrders(
  panels: SortPanelRow[],
  bubbles: SortBubbleRow[],
  result: GeminiSortResponse,
): {
  panelOrders: Map<string, number>;
  bubbleGlobalOrder: Map<string, number>;
} {
  const panelIds = new Set(panels.map((p) => p.id));
  const bubbleIds = new Set(bubbles.map((b) => b.id));

  const seenPanels = new Set<string>();
  const seenBubbles = new Set<string>();

  const panelOrders = new Map<string, number>();
  for (const entry of result.panels) {
    if (!panelIds.has(entry.panelId)) {
      throw new Error(`Unknown panelId in response: ${entry.panelId}`);
    }
    if (seenPanels.has(entry.panelId)) {
      throw new Error(`Duplicate panelId in response: ${entry.panelId}`);
    }
    seenPanels.add(entry.panelId);
    for (const b of entry.bubbles ?? []) {
      if (!bubbleIds.has(b.bubbleId)) {
        throw new Error(`Unknown bubbleId in response: ${b.bubbleId}`);
      }
      if (seenBubbles.has(b.bubbleId)) {
        throw new Error(`Duplicate bubbleId in response: ${b.bubbleId}`);
      }
      seenBubbles.add(b.bubbleId);
    }
  }

  if (seenPanels.size !== panelIds.size) {
    const missing = [...panelIds].filter((id) => !seenPanels.has(id));
    throw new Error(`Missing panels in response: ${missing.join(", ")}`);
  }
  if (seenBubbles.size !== bubbleIds.size) {
    const missing = [...bubbleIds].filter((id) => !seenBubbles.has(id));
    throw new Error(`Missing bubbles in response: ${missing.join(", ")}`);
  }

  const sortedPanels = [...result.panels].sort(
    (a, b) => a.sortOrder - b.sortOrder,
  );
  sortedPanels.forEach((p, idx) => panelOrders.set(p.panelId, idx));

  const bubbleGlobalOrder = new Map<string, number>();
  let globalIdx = 0;
  for (const p of sortedPanels) {
    const sortedBubbles = [...(p.bubbles ?? [])].sort(
      (a, b) => a.sortOrder - b.sortOrder,
    );
    for (const b of sortedBubbles) {
      bubbleGlobalOrder.set(b.bubbleId, globalIdx++);
    }
  }

  return { panelOrders, bubbleGlobalOrder };
}

function sortBubbleRowsHeuristic(
  bubbles: SortBubbleRow[],
  imgW: number,
  imgH: number,
): string[] {
  const ROW_TOLERANCE = 50;
  const positioned = bubbles.map((b) => {
    let x = b.box_2d?.x ?? 0;
    let y = b.box_2d?.y ?? 0;
    if (x === 0 && y === 0 && b.style && imgW > 0 && imgH > 0) {
      const pct = (s: string | undefined) => parseFloat(s ?? "0") / 100;
      x = Math.floor(pct(b.style.left) * imgW);
      y = Math.floor(pct(b.style.top) * imgH);
    }
    return { id: b.id, x, y };
  });
  return [...positioned]
    .sort((a, b) => {
      if (Math.abs(a.y - b.y) < ROW_TOLERANCE) return a.x - b.x;
      return a.y - b.y;
    })
    .map((p) => p.id);
}

export async function sortPageElements(
  bookId: string,
  issueId: string,
  pageNumber: number,
) {
  "use step";
  const { createStepClient } = await import("../step-utils");
  const supabase = await createStepClient();

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");
  const gemini = new GoogleGenAI({ apiKey });

  const padded = String(pageNumber).padStart(2, "0");
  const storagePath = `${bookId}/${issueId}/pages/page-${padded}.webp`;

  const { data: imageBlob, error: dlErr } = await supabase.storage
    .from("comic-pages")
    .download(storagePath);

  if (dlErr || !imageBlob) {
    console.warn(
      `[sort] ${bookId}/${issueId}: page-${padded}: missing WebP (${dlErr?.message ?? "no data"}) — skip`,
    );
    return;
  }

  const pageImage = Buffer.from(await imageBlob.arrayBuffer());
  const meta = await sharp(pageImage).metadata();
  const imgW = meta.width ?? 0;
  const imgH = meta.height ?? 0;

  const { data: panelRows, error: pErr } = await supabase
    .from("panels")
    .select("id, panel_id, page_number, sort_order, bounding_box")
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("page_number", pageNumber);

  if (pErr) throw new Error(`panels query: ${pErr.message}`);

  const { data: bubbleRows, error: bErr } = await supabase
    .from("bubbles")
    .select(
      "id, legacy_id, panel_id, sort_order, ocr_text, text_with_cues, ignored, box_2d, style",
    )
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("page_number", pageNumber);

  if (bErr) throw new Error(`bubbles query: ${bErr.message}`);

  const panels = (panelRows ?? []) as SortPanelRow[];
  const bubbles = (bubbleRows ?? []) as SortBubbleRow[];

  if (panels.length === 0 && bubbles.length === 0) {
    console.log(
      `[sort] ${bookId}/${issueId}: page-${padded}: no panels or bubbles — skip`,
    );
    return;
  }

  if (panels.length === 0 && bubbles.length > 0) {
    const orderedIds = sortBubbleRowsHeuristic(bubbles, imgW, imgH);
    const bubbleGlobalOrder = new Map<string, number>();
    orderedIds.forEach((id, idx) => bubbleGlobalOrder.set(id, idx));
    const bubbleUpdates = [...bubbleGlobalOrder.entries()].map(
      ([id, sort_order]) =>
        supabase.from("bubbles").update({ sort_order }).eq("id", id),
    );
    const results = await Promise.all(bubbleUpdates);
    const errResult = results.find((r) => r.error);
    if (errResult?.error) throw new Error(errResult.error.message);
    console.log(
      `[sort] ${bookId}/${issueId}: page-${padded}: 0 panels — heuristic bubble sort (${bubbles.length})`,
    );
    return;
  }

  const plan = await getSortPlanFromGemini(
    gemini,
    pageImage,
    imgW,
    imgH,
    panels,
    bubbles,
  );
  const { panelOrders, bubbleGlobalOrder } = validateAndFlattenOrders(
    panels,
    bubbles,
    plan,
  );

  const panelUpdates = [...panelOrders.entries()].map(([id, sort_order]) =>
    supabase.from("panels").update({ sort_order }).eq("id", id),
  );
  const bubbleUpdates = [...bubbleGlobalOrder.entries()].map(
    ([id, sort_order]) =>
      supabase.from("bubbles").update({ sort_order }).eq("id", id),
  );

  const results = await Promise.all([...panelUpdates, ...bubbleUpdates]);
  const errResult = results.find((r) => r.error);
  if (errResult?.error) throw new Error(errResult.error.message);

  console.log(
    `[sort] ${bookId}/${issueId}: page-${padded}: ${panels.length} panel(s), ${bubbles.length} bubble(s)`,
  );
}

export async function addBubbleStyles(bookId: string, issueId: string) {
  "use step";
  const { createStepClient } = await import("../step-utils");
  const supabase = await createStepClient();

  const { data: pages } = await supabase
    .from("pages")
    .select("page_number, width, height")
    .eq("book_id", bookId)
    .eq("issue_id", issueId);

  if (!pages || pages.length === 0) {
    console.log(`[styles] ${bookId}/${issueId}: no pages found, skipping`);
    return;
  }

  const pageDims = new Map(
    pages.map((p: { page_number: number; width: number; height: number }) => [
      p.page_number,
      { width: p.width, height: p.height },
    ]),
  );

  const { data: bubbles } = await supabase
    .from("bubbles")
    .select("id, page_number, x, y, width, height")
    .eq("book_id", bookId)
    .eq("issue_id", issueId);

  if (!bubbles || bubbles.length === 0) return;

  type BubbleRow = {
    id: string;
    page_number: number;
    x: number;
    y: number;
    width: number;
    height: number;
  };

  const updates = (bubbles as BubbleRow[])
    .filter((b) => pageDims.has(b.page_number))
    .map((b) => {
      const dim = pageDims.get(b.page_number)!;
      return {
        id: b.id,
        style_left: (b.x / dim.width) * 100,
        style_top: (b.y / dim.height) * 100,
        style_width: (b.width / dim.width) * 100,
        style_height: (b.height / dim.height) * 100,
      };
    });

  for (const u of updates) {
    await supabase
      .from("bubbles")
      .update({
        style_left: u.style_left,
        style_top: u.style_top,
        style_width: u.style_width,
        style_height: u.style_height,
      })
      .eq("id", u.id);
  }

  console.log(
    `[styles] ${bookId}/${issueId}: updated ${updates.length} bubbles`,
  );
}

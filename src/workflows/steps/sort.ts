import {
  type GenerateContentParameters,
  type GenerateContentResponse,
  type GoogleGenAI,
  ThinkingLevel,
  createPartFromBase64,
  createPartFromText,
} from "@google/genai";
import sharp from "sharp";
import { FatalError } from "workflow";
import type { LlmCallMeta } from "~/lib/llm-usage";
import { GEMINI_MEDIUM } from "~/lib/models";
import { pageStoragePath } from "~/lib/storage";
import { computeBubbleStyle, getBubbleStyleSkipReason } from "./bubble-style";

/**
 * A Supabase error with a Postgres or PostgREST code is a data error that a
 * retry won't cure, so it fails the step now. No code means no database answer:
 * a dropped connection comes back as `TypeError: fetch failed` with code "", and
 * PGRST0xx means PostgREST couldn't reach Postgres. Those throw a plain Error so
 * the Workflow retries the step.
 */
function dbError(label: string, error: { message: string; code?: string }) {
  const message = `${label}: ${error.message}`;
  const transient = !error.code || error.code.startsWith("PGRST0");
  return transient ? new Error(message) : new FatalError(message);
}

/**
 * Storage answers a missing object with HTTP 400 and statusCode "404"; that page
 * has no image to sort, so this returns null and the step skips the page. Any
 * other failure is a download that didn't finish: a dropped connection comes
 * back with no status, a gateway failure with a 5xx, and a download can return
 * neither error nor data. Those return a plain Error so the Workflow retries the
 * step, which costs nothing because the download runs before the Gemini call.
 */
export function downloadError(
  label: string,
  error: { message: string; statusCode?: string } | null,
) {
  if (error?.statusCode === "404") return null;
  return new Error(
    `${label}: page image download failed (${error?.message ?? "no data"})`,
  );
}

/**
 * Writes after a paid Gemini call. A Workflow retry would repeat that call, so
 * transient failures re-send only the failed writes here, up to 3 attempts.
 */
async function writeAfterPaidCall(
  label: string,
  writes: (() => PromiseLike<{
    error: Parameters<typeof dbError>[1] | null;
  }>)[],
) {
  for (let attempt = 1; ; attempt++) {
    // A write that throws or rejects counts as a codeless (transient) error.
    const results = await Promise.all(
      writes.map((write) =>
        Promise.resolve()
          .then(write)
          .then(
            (r) => r.error,
            (e: unknown) => ({ message: String(e) }),
          ),
      ),
    );
    const errors = results.flatMap((err) => (err ? [dbError(label, err)] : []));
    if (errors.length === 0) return;
    const fatal = errors.find((e) => e instanceof FatalError);
    if (fatal) throw fatal;
    if (attempt === 3) {
      throw new FatalError(`${errors[0]!.message} (after 3 attempts)`);
    }
    writes = writes.filter((_, i) => results[i]);
    await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
  }
}

type BoundingBoxJson = { x: number; y: number; w: number; h: number };

export interface SortPanelRow {
  id: string;
  panel_id: string;
  page_number: number;
  sort_order: number;
  bounding_box: BoundingBoxJson;
  source: string;
}

export interface SortBubbleRow {
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

/**
 * Short per-page handles (`p1`, `b1`, ...) keyed by row UUID. The prompt names
 * rows by handle, because a model copying 36-character UUIDs back drops a
 * character now and then and the step fails (#307).
 */
export interface PageHandles {
  panel: Map<string, string>;
  bubble: Map<string, string>;
}

export function pageHandles(
  panels: SortPanelRow[],
  bubbles: SortBubbleRow[],
): PageHandles {
  return {
    panel: new Map(panels.map((p, i) => [p.id, `p${i + 1}`])),
    bubble: new Map(bubbles.map((b, i) => [b.id, `b${i + 1}`])),
  };
}

/** Maps the response's handles back to UUIDs; an unknown handle throws. */
export function planWithIds(
  plan: GeminiSortResponse,
  handles: PageHandles,
): GeminiSortResponse {
  const reverse = (m: Map<string, string>) =>
    new Map([...m].map(([id, handle]) => [handle, id]));
  const panelIds = reverse(handles.panel);
  const bubbleIds = reverse(handles.bubble);
  return {
    panels: plan.panels.map((entry) => {
      const panelId = panelIds.get(entry.panelId);
      if (!panelId) {
        throw new Error(`Unknown panelId in response: ${entry.panelId}`);
      }
      return {
        ...entry,
        panelId,
        bubbles: (entry.bubbles ?? []).map((b) => {
          const bubbleId = bubbleIds.get(b.bubbleId);
          if (!bubbleId) {
            throw new Error(`Unknown bubbleId in response: ${b.bubbleId}`);
          }
          return { ...b, bubbleId };
        }),
      };
    }),
  };
}

function bubbleSnippet(b: SortBubbleRow): string {
  const t = (b.text_with_cues ?? b.ocr_text ?? "").trim();
  return t.length > 120 ? `${t.slice(0, 117)}...` : t;
}

function bubbleLayoutLine(
  b: SortBubbleRow,
  imgW: number,
  imgH: number,
  handles: PageHandles,
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
  const panelHint =
    (b.panel_id ? handles.panel.get(b.panel_id) : undefined) ?? "none";
  return `- bubbleId: ${handles.bubble.get(b.id)}\n  assigned_panelId: ${panelHint}\n  bbox_normalized: x=${nx.toFixed(4)}, y=${ny.toFixed(4)}, w=${nw.toFixed(4)}, h=${nh.toFixed(4)}\n  text: "${bubbleSnippet(b).replace(/"/g, '\\"')}"\n  ignored: ${b.ignored}`;
}

export function sortPrompt(
  imgW: number,
  imgH: number,
  panels: SortPanelRow[],
  bubbles: SortBubbleRow[],
  handles: PageHandles,
): string {
  const panelLines = panels
    .map((p) => {
      const bb = p.bounding_box;
      return `- panelId: ${handles.panel.get(p.id)}\n  current_sort_order: ${p.sort_order}\n  bbox_normalized: x=${bb.x}, y=${bb.y}, w=${bb.w}, h=${bb.h}`;
    })
    .join("\n");

  const bubbleLines = bubbles.map((b) =>
    bubbleLayoutLine(b, imgW, imgH, handles),
  );

  return `You are analyzing a comic book page image.

**Task:** Determine:
1. The correct READING ORDER of **panels** on this page (Western comics: mostly top-to-bottom rows, left-to-right within a row; manga may use right-to-left columns — follow what the layout implies).
2. Within EACH panel, the correct reading order of **speech bubbles / captions** (follow tails, narrative flow, and spatial cues).

**Panel records (bbox x,y,w,h are fractions of page width/height, origin top-left):**
${panelLines || "(no panels)"}

**Bubble records:**
${bubbleLines.join("\n") || "(no bubbles)"}

**Rules:**
- Use each panel's **panelId** exactly as given. It is a short handle such as \`p1\`.
- Use each bubble's **bubbleId** exactly as given. It is a short handle such as \`b1\`.
- The handle numbers (\`p1\`, \`b3\`) are labels only and say nothing about reading order. Take the order from the image and the bboxes.
- Include EVERY panel id exactly once in your output.
- Include EVERY bubble id exactly once inside the \`bubbles\` array of exactly one panel (the panel where the bubble visually belongs). If unsure, pick the panel whose bbox contains the bubble center.
- Bubbles with ignored=true should still be listed in reading order (they remain in the narrative layout).

**Output — JSON only (no markdown fences):**
{
  "panels": [
    {
      "panelId": "<panelId>",
      "sortOrder": 0,
      "bubbles": [
        { "bubbleId": "<bubbleId>", "sortOrder": 0 }
      ]
    }
  ]
}

- \`panels[].sortOrder\`: 0-based order for panels across the page.
- \`bubbles[].sortOrder\`: 0-based order within that panel only.
`;
}

/**
 * The sort request: page image, prompt, model. Unset, `options` leave it as
 * the step sends it, GEMINI_MEDIUM at `thinkingLevel: LOW` (decisions row
 * 296: LOW holds the default's reading order at about a third of the cost).
 * The reading order bench sets `model` and `thinkingLevel` and sends this
 * same request; `thinkingLevel: null` sends no thinking config, the model's
 * default.
 */
export function sortPlanRequest(
  pageImage: Buffer,
  prompt: string,
  options: { model?: string; thinkingLevel?: ThinkingLevel | null } = {},
): GenerateContentParameters {
  const thinkingLevel =
    options.thinkingLevel === undefined
      ? ThinkingLevel.LOW
      : options.thinkingLevel;
  return {
    model: options.model ?? GEMINI_MEDIUM,
    contents: [
      createPartFromBase64(pageImage.toString("base64"), "image/webp"),
      createPartFromText(prompt),
    ],
    ...(thinkingLevel ? { config: { thinkingConfig: { thinkingLevel } } } : {}),
  };
}

/**
 * The paid call only. The caller reads `.text` (an SDK getter that can throw)
 * and parses it inside its fail-fast block (`sortPlanFromResponse`).
 */
async function getSortPlanResponseFromGemini(
  gemini: GoogleGenAI,
  pageImage: Buffer,
  prompt: string,
  llmMeta: LlmCallMeta,
): Promise<GenerateContentResponse> {
  const { generateContentLogged } = await import("~/lib/llm-usage");
  return generateContentLogged(
    gemini,
    sortPlanRequest(pageImage, prompt),
    llmMeta,
  );
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

/**
 * The reply as the step reads it: text, JSON, handles back to UUIDs, then
 * every panel and bubble exactly once. `plan` is the reply with UUIDs, which
 * the bench reads for each bubble's panel. Throws a plain Error on any failure;
 * the step turns it into a FatalError, the reading order bench (#443) into a
 * failed reply.
 */
export function sortPlanFromResponse(
  response: GenerateContentResponse,
  panels: SortPanelRow[],
  bubbles: SortBubbleRow[],
  handles: PageHandles,
) {
  const text = response.text;
  if (!text) throw new Error("No text response from Gemini");
  const plan = JSON.parse(extractJsonObject(text)) as GeminiSortResponse;
  if (!plan.panels || !Array.isArray(plan.panels)) {
    throw new Error("Invalid response: missing panels array");
  }
  const withIds = planWithIds(plan, handles);
  return {
    ...validateAndFlattenOrders(panels, bubbles, withIds),
    plan: withIds,
  };
}

/**
 * No detected panel: none, or a lone full-page panel (#237). Such a page
 * takes the free heuristic, not the Gemini sort (#306).
 */
export function takesHeuristicSort(panels: SortPanelRow[]) {
  const onlyFullPage =
    panels.length === 1 && panels[0]!.source === "heuristic-fullpage";
  return {
    noDetectedPanels: panels.length === 0 || onlyFullPage,
    onlyFullPage,
  };
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
  const { createTypedStepClient } = await import("../step-utils");
  const supabase = await createTypedStepClient();

  const { getGeminiClient } = await import("~/lib/gemini-client");
  const gemini = getGeminiClient();

  const padded = String(pageNumber).padStart(2, "0");
  const storagePath = pageStoragePath(bookId, issueId, pageNumber);

  const { data: imageBlob, error: dlErr } = await supabase.storage
    .from("comic-pages")
    .download(storagePath);

  if (dlErr || !imageBlob) {
    const retry = downloadError(
      `sort ${bookId}/${issueId} page-${padded}`,
      dlErr,
    );
    if (retry) throw retry;
    console.warn(
      `[sort] ${bookId}/${issueId}: page-${padded}: missing WebP (${dlErr?.message ?? "no data"}), skip`,
    );
    return;
  }

  const pageImage = Buffer.from(await imageBlob.arrayBuffer());
  const meta = await sharp(pageImage).metadata();
  const imgW = meta.width ?? 0;
  const imgH = meta.height ?? 0;

  const { data: panelRows, error: pErr } = await supabase
    .from("panels")
    .select("id, panel_id, page_number, sort_order, bounding_box, source")
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("page_number", pageNumber)
    .order("sort_order")
    .order("id");

  if (pErr) throw dbError("panels", pErr);

  const { data: bubbleRows, error: bErr } = await supabase
    .from("bubbles")
    .select(
      "id, legacy_id, panel_id, sort_order, ocr_text, text_with_cues, ignored, box_2d, style",
    )
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("page_number", pageNumber)
    .order("sort_order")
    .order("id");

  if (bErr) throw dbError("bubbles", bErr);

  const panels = (panelRows ?? []) as SortPanelRow[];
  const bubbles = (bubbleRows ?? []) as SortBubbleRow[];

  const { noDetectedPanels, onlyFullPage } = takesHeuristicSort(panels);

  if (noDetectedPanels && bubbles.length === 0) {
    console.log(
      `[sort] ${bookId}/${issueId}: page-${padded}: no panels or bubbles, skip`,
    );
    return;
  }

  if (noDetectedPanels && bubbles.length > 0) {
    const orderedIds = sortBubbleRowsHeuristic(bubbles, imgW, imgH);
    const bubbleGlobalOrder = new Map<string, number>();
    orderedIds.forEach((id, idx) => bubbleGlobalOrder.set(id, idx));
    const bubbleUpdates = [...bubbleGlobalOrder.entries()].map(
      ([id, sort_order]) =>
        supabase.from("bubbles").update({ sort_order }).eq("id", id),
    );
    const results = await Promise.all(bubbleUpdates);
    const errors = results.flatMap((r) =>
      r.error ? [dbError("bubbles", r.error)] : [],
    );
    if (errors[0]) {
      throw errors.find((e) => e instanceof FatalError) ?? errors[0];
    }
    console.log(
      `[sort] ${bookId}/${issueId}: page-${padded}: ${onlyFullPage ? "full-page panel only" : "0 panels"}, heuristic bubble sort (${bubbles.length})`,
    );
    return;
  }

  const handles = pageHandles(panels, bubbles);
  const response = await getSortPlanResponseFromGemini(
    gemini,
    pageImage,
    sortPrompt(imgW, imgH, panels, bubbles, handles),
    {
      step: "sort-page-elements",
      bookId,
      issueId,
      pageNumber,
      serviceTier: "flex",
    },
  );

  // Past the paid call: a Workflow retry would pay for Gemini again, so every
  // failure from here on is a FatalError, including the `.text` getter.
  try {
    const { panelOrders, bubbleGlobalOrder } = sortPlanFromResponse(
      response,
      panels,
      bubbles,
      handles,
    );

    await writeAfterPaidCall("panels/bubbles", [
      ...[...panelOrders.entries()].map(
        ([id, sort_order]) =>
          () =>
            supabase.from("panels").update({ sort_order }).eq("id", id),
      ),
      ...[...bubbleGlobalOrder.entries()].map(
        ([id, sort_order]) =>
          () =>
            supabase.from("bubbles").update({ sort_order }).eq("id", id),
      ),
    ]);
  } catch (e) {
    if (e instanceof FatalError) throw e;
    const message = e instanceof Error ? e.message : String(e);
    throw new FatalError(`sort plan: ${message}`);
  }

  console.log(
    `[sort] ${bookId}/${issueId}: page-${padded}: ${panels.length} panel(s), ${bubbles.length} bubble(s)`,
  );
}

export async function addBubbleStyles(bookId: string, issueId: string) {
  "use step";
  const { createTypedStepClient } = await import("../step-utils");
  const supabase = await createTypedStepClient();

  const { data: pages, error: pagesError } = await supabase
    .from("pages")
    .select("number, width, height")
    .eq("book_id", bookId)
    .eq("issue_id", issueId);

  if (pagesError) throw dbError("pages", pagesError);

  if (!pages || pages.length === 0) {
    console.log(`[styles] ${bookId}/${issueId}: no pages found, skipping`);
    return;
  }

  const pageDims = new Map(
    pages.map((p) => [p.number, { width: p.width, height: p.height }]),
  );

  const { data: bubbles, error: bubblesError } = await supabase
    .from("bubbles")
    .select("id, page_number, box_2d, style")
    .eq("book_id", bookId)
    .eq("issue_id", issueId);

  if (bubblesError) throw dbError("bubbles", bubblesError);

  if (!bubbles || bubbles.length === 0) return;

  let written = 0;
  let skipped = 0;
  for (const bubble of bubbles) {
    const dim = pageDims.get(bubble.page_number);
    const verdict = getBubbleStyleSkipReason(bubble, dim);
    if ("skip" in verdict) {
      skipped++;
      console.log(`[styles] skip ${bubble.id}: ${verdict.skip}`);
      continue;
    }

    const { pageWidth, pageHeight, box2d } = verdict.ready;
    const style = computeBubbleStyle(box2d, pageWidth, pageHeight)!;

    const { data: updated, error } = await supabase
      .from("bubbles")
      .update({ style })
      .eq("id", bubble.id)
      .is("style", null)
      .select("id");
    if (error) throw dbError("bubbles", error);
    if (!updated || updated.length === 0) {
      skipped++;
      console.log(`[styles] skip ${bubble.id}: style set concurrently`);
      continue;
    }
    written++;
  }

  console.log(
    `[styles] ${bookId}/${issueId}: written ${written}, skipped ${skipped}`,
  );
}

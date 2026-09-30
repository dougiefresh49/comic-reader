import type { SupabaseClient } from "@supabase/supabase-js";
import sharp from "sharp";
import { FatalError } from "workflow";
import { GEMINI_MEDIUM } from "~/lib/models";
import { filterDuplicatePanels, filterSliverPanels } from "~/lib/panel-filter";
import { pageImageUrl, pageStoragePath } from "~/lib/storage";
import type { Database, Json, TablesInsert } from "~/types/database";
import type { PageMeta, BoundingBoxJson } from "./shared";
import {
  bubbleHasContext,
  buildContextUpdate,
  mapBubbleRows,
  mapForegroundPolygons,
  mapPanelRows,
  mapSegmentationRow,
  normalizePanelAudioTags,
  parseRoboflowSam3Output,
  type ContextParsed,
  type ForegroundPrediction,
  type ParsedRoboflowSam3,
  type RoboflowBoxPrediction,
  type RoboflowSam3Output,
} from "./vision-rows";
import { selectIssue } from "~/lib/issue-queries";
import type {
  downloadExemplarImage,
  findSimilarExemplars,
} from "~/lib/exemplar-store";

type TypedClient = SupabaseClient<Database>;

export {
  bubbleHasContext,
  buildContextUpdate,
  mapBubbleRows,
  mapPanelRows,
  mapSegmentationRow,
  parseRoboflowSam3Output,
} from "./vision-rows";

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 160);
}

type RoboflowRead = { data: { outputs?: unknown[] } } | { failure: string };

/**
 * One Roboflow call read down to a JSON object, or the reason it failed.
 * Never throws: each caller decides between the failed-pages list and a
 * FatalError.
 */
export async function readRoboflowJson(
  call: () => Promise<Response>,
): Promise<RoboflowRead> {
  let res: Response;
  try {
    res = await call();
  } catch (err: unknown) {
    return { failure: `fetch failed: ${errorText(err)}` };
  }
  if (!res.ok) {
    const body = await res
      .text()
      .catch((err: unknown) => `(body unreadable: ${errorText(err)})`);
    return { failure: `HTTP ${res.status}: ${body.slice(0, 160)}` };
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch (err: unknown) {
    return { failure: `non-JSON response: ${errorText(err)}` };
  }
  if (!data || typeof data !== "object") {
    return { failure: `response body is ${String(data)}, not an object` };
  }
  return { data: data as { outputs?: unknown[] } };
}

export async function readSam3Response(
  call: () => Promise<Response>,
): Promise<{ parsed: ParsedRoboflowSam3 } | { failure: string }> {
  const read = await readRoboflowJson(call);
  if ("failure" in read) return read;
  const parsed = parseRoboflowSam3Output(
    read.data.outputs?.[0] as RoboflowSam3Output | undefined,
  );
  return parsed
    ? { parsed }
    : { failure: "missing or malformed predictions in response" };
}

/**
 * The `getContextPage` fallback for a page with no bubbles. Every failure is
 * fatal: a workflow retry would call Roboflow and bill it again. An empty
 * predictions array is a page with no text, not a failure.
 */
export async function roboflowTextPredictionsOrFatal(
  call: () => Promise<Response>,
  pageLabel: string,
): Promise<RoboflowBoxPrediction[]> {
  const read = await readRoboflowJson(call);
  if ("failure" in read) {
    throw new FatalError(
      `Roboflow text detection failed for ${pageLabel}: ${read.failure}`,
    );
  }
  const first = read.data.outputs?.[0] as
    | { predictions?: { predictions?: unknown } }
    | undefined;
  const preds = first?.predictions?.predictions;
  if (!Array.isArray(preds)) {
    throw new FatalError(
      `Roboflow text detection failed for ${pageLabel}: no predictions array in response`,
    );
  }
  const bad = preds.findIndex(
    (p: Record<string, unknown> | null) =>
      !p || !["x", "y", "width", "height"].every((k) => Number.isFinite(p[k])),
  );
  if (bad !== -1) {
    throw new FatalError(
      `Roboflow text detection failed for ${pageLabel}: prediction ${bad} is not a box`,
    );
  }
  return preds as RoboflowBoxPrediction[];
}

/**
 * One face identification, retried on the fallback key after a 429. Any
 * other failure is fatal, so a page with a failed face stores no detections
 * and a rerun does it again.
 */
export async function identifyFaceOrFatal<C, T>(
  run: (client: C) => Promise<T>,
  primary: C,
  getFallback: () => C | null,
  pageLabel: string,
): Promise<T> {
  try {
    return await run(primary);
  } catch (err: unknown) {
    let last = err;
    const status = (err as { status?: number } | null)?.status;
    const fallback = status === 429 ? getFallback() : null;
    if (fallback) {
      try {
        return await run(fallback);
      } catch (retryErr: unknown) {
        last = retryErr;
      }
    }
    throw new FatalError(
      `Gemini face identification failed for ${pageLabel}: ${errorText(last)}`,
    );
  }
}

/**
 * A page's lookahead is finished when any of its panels has a
 * `panel_character_detections` row. That insert is the step's last write
 * and one statement, and a failed face is fatal before it
 * (`identifyFaceOrFatal`), so a page with any face unhandled has no
 * detections and runs again.
 */
export async function hasStoredFaceDetections(
  supabase: TypedClient,
  panelIds: string[],
  pageLabel: string,
): Promise<boolean> {
  if (panelIds.length === 0) return false;
  const { count, error } = await supabase
    .from("panel_character_detections")
    .select("id", { count: "exact", head: true })
    .in("panel_id", panelIds);
  if (error) {
    throw new FatalError(
      `panel_character_detections read failed for ${pageLabel}: ${error.message}`,
    );
  }
  return (count ?? 0) > 0;
}

export type ExemplarRef = {
  characterName: string;
  jpegBase64: string;
  confidence: number;
};

type ExemplarStore = {
  findSimilarExemplars: typeof findSimilarExemplars;
  downloadExemplarImage: typeof downloadExemplarImage;
};

/**
 * Similar stored faces for one crop. The embedding already retries a 429 on
 * the fallback key (`~/lib/embeddings`), so anything that reaches here is
 * fatal for the page. The store is passed in: an import here would pull
 * Node-only modules into the workflow bundle.
 */
export async function exemplarRefsOrFatal(
  { findSimilarExemplars, downloadExemplarImage }: ExemplarStore,
  supabase: TypedClient,
  faceJpegBase64: string,
  bookId: string,
  pageLabel: string,
): Promise<ExemplarRef[]> {
  try {
    const matches = await findSimilarExemplars(
      supabase,
      faceJpegBase64,
      [bookId],
      3,
    );
    const refs = await Promise.all(
      matches.map(async (m) => {
        const img = await downloadExemplarImage(supabase, m.cropPath);
        if (!img) return null;
        return {
          characterName: m.characterId,
          jpegBase64: img.toString("base64"),
          confidence: m.confidence,
        };
      }),
    );
    return refs.filter((r): r is ExemplarRef => r !== null);
  } catch (err: unknown) {
    throw new FatalError(
      `exemplar lookup failed for ${pageLabel}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
}

function fuzzyNameMatch(a: string, b: string): boolean {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const wordsA = na.split(" ");
  const wordsB = nb.split(" ");
  if (wordsA.length >= 2 && wordsB.length >= 2) {
    if (
      wordsA[0] === wordsB[0] &&
      wordsA[wordsA.length - 1] === wordsB[wordsB.length - 1]
    ) {
      return true;
    }
  }
  return false;
}

async function buildKnownCharacterListOrFatal(
  supabase: TypedClient,
  bookId: string,
  pageLabel: string,
): Promise<string[]> {
  const { data: book, error: bookErr } = await supabase
    .from("books")
    .select("franchises")
    .eq("id", bookId)
    .single();
  if (bookErr) {
    throw new FatalError(
      `books read failed for ${pageLabel}: ${bookErr.message}`,
    );
  }

  const franchises = book?.franchises ?? [];
  let chars: Array<{ id: string; aliases: string[] | null }>;
  if (franchises.length > 0) {
    const franchiseFilter = franchises
      .map((f) => `franchise.eq.${f}`)
      .join(",");
    const { data, error } = await supabase
      .from("characters")
      .select("id, aliases")
      .or(`${franchiseFilter},franchise.is.null`);
    if (error) {
      throw new FatalError(
        `characters read failed for ${pageLabel}: ${error.message}`,
      );
    }
    chars = data ?? [];
  } else {
    const { data, error } = await supabase
      .from("characters")
      .select("id, aliases");
    if (error) {
      throw new FatalError(
        `characters read failed for ${pageLabel}: ${error.message}`,
      );
    }
    chars = data ?? [];
  }

  const names: string[] = [];
  const seen = new Set<string>();
  for (const c of chars) {
    const readable = c.id.replace(/-/g, " ");
    if (!seen.has(readable.toLowerCase())) {
      names.push(readable);
      seen.add(readable.toLowerCase());
    }
    if (c.aliases) {
      for (const a of c.aliases) {
        if (!seen.has(a.toLowerCase())) {
          names.push(a);
          seen.add(a.toLowerCase());
        }
      }
    }
  }
  return names;
}

async function resolveCharacterIdOrFatal(
  supabase: TypedClient,
  name: string,
  pageLabel: string,
): Promise<string | null> {
  const directId = name.toLowerCase().replace(/\s+/g, "-");
  const { data: direct, error: directErr } = await supabase
    .from("characters")
    .select("id")
    .eq("id", directId)
    .maybeSingle();
  if (directErr) {
    throw new FatalError(
      `characters read failed for ${pageLabel}: ${directErr.message}`,
    );
  }
  if (direct) return directId;

  const { data: allChars, error: allErr } = await supabase
    .from("characters")
    .select("id, aliases")
    .limit(200);
  if (allErr) {
    throw new FatalError(
      `characters read failed for ${pageLabel}: ${allErr.message}`,
    );
  }

  if (allChars) {
    for (const row of allChars) {
      const id = row.id;
      const aliases = row.aliases ?? [];
      if (fuzzyNameMatch(name, id)) return id;
      if (aliases.some((a) => fuzzyNameMatch(name, a))) return id;
    }
  }

  return null;
}

/**
 * Decisions row 124: a page where the model keeps no panel gets one panel
 * covering the whole page, the shape issue-2 and issue-3 got by SQL. With a
 * panel row present, the next run skips the Roboflow call (#237).
 */
function fullPagePanelRow(
  bookId: string,
  issueId: string,
  pageNumber: number,
): TablesInsert<"panels"> {
  return {
    book_id: bookId,
    issue_id: issueId,
    page_number: pageNumber,
    panel_id: `p${String(pageNumber).padStart(2, "0")}-01`,
    sort_order: 0,
    source: "heuristic-fullpage",
    bounding_box: { x: 0, y: 0, w: 1, h: 1 },
    audio_tags: { ...normalizePanelAudioTags(null) },
  };
}

/**
 * Link the page's unlinked bubbles to its full-page panel, writing the panel
 * first when `create` is set. The row is read back by page and panel_id, so a
 * concurrent insert (an empty upsert return) resolves, and a detected panel
 * that holds the same panel_id never gets bubbles relinked onto it.
 */
async function linkFullPagePanel(
  supabase: TypedClient,
  row: TablesInsert<"panels">,
  create: boolean,
  pageLabel: string,
) {
  if (create) {
    const { error } = await supabase.from("panels").upsert(row, {
      onConflict: "book_id,issue_id,panel_id",
      ignoreDuplicates: true,
    });
    if (error) {
      throw new FatalError(
        `full-page panel upsert failed for ${pageLabel}: ${error.message}`,
      );
    }
  }
  const { data: panel, error: readErr } = await supabase
    .from("panels")
    .select("id, source")
    .eq("book_id", row.book_id)
    .eq("issue_id", row.issue_id)
    .eq("page_number", row.page_number)
    .eq("panel_id", row.panel_id)
    .maybeSingle();
  if (readErr || !panel) {
    throw new FatalError(
      `full-page panel read failed for ${pageLabel}: ${readErr?.message ?? "no row"}`,
    );
  }
  if (panel.source !== "heuristic-fullpage") {
    console.warn(
      `[roboflow] ${pageLabel}: ${row.panel_id} is a ${panel.source} panel, bubbles not linked`,
    );
    return;
  }
  const { error: lErr } = await supabase
    .from("bubbles")
    .update({ panel_id: panel.id })
    .eq("book_id", row.book_id)
    .eq("issue_id", row.issue_id)
    .eq("page_number", row.page_number)
    .is("panel_id", null);
  if (lErr) {
    throw new FatalError(
      `bubbles panel link failed for ${pageLabel}: ${lErr.message}`,
    );
  }
}

export async function roboflowAnalyzeBatch(
  bookId: string,
  issueId: string,
  pages: PageMeta[],
) {
  "use step";
  const { createTypedStepClient } = await import("../step-utils");
  const supabase = await createTypedStepClient();

  const { env } = await import("~/env.mjs");
  const workflowUrl = env.ROBOFLOW_SAM3_WORKFLOW_URL;
  const { runRoboflowWorkflow } = await import("~/lib/roboflow-client");
  const apiKey = process.env.ROBOFLOW_API_KEY;
  if (!apiKey) {
    throw new FatalError("ROBOFLOW_API_KEY required");
  }

  const failedPageLabels: string[] = [];

  for (const page of pages) {
    const padded = String(page.pageNumber).padStart(2, "0");
    const pageLabel = `page-${padded}`;

    const { data: pagePanels, error: panelCountErr } = await supabase
      .from("panels")
      .select("source")
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .eq("page_number", page.pageNumber);
    if (panelCountErr) {
      throw new FatalError(
        `panels count failed for ${pageLabel}: ${panelCountErr.message}`,
      );
    }

    const { count: segCount, error: segCountErr } = await supabase
      .from("page_segmentation")
      .select("*", { count: "exact", head: true })
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .eq("page_number", page.pageNumber);
    if (segCountErr) {
      throw new FatalError(
        `page_segmentation count failed for ${pageLabel}: ${segCountErr.message}`,
      );
    }

    const { count: bubbleCount, error: bubbleCountErr } = await supabase
      .from("bubbles")
      .select("*", { count: "exact", head: true })
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .eq("page_number", page.pageNumber);
    if (bubbleCountErr) {
      throw new FatalError(
        `bubbles count failed for ${pageLabel}: ${bubbleCountErr.message}`,
      );
    }

    const existingPanels = pagePanels.length;
    const existingSeg = segCount ?? 0;
    const existingBubbles = bubbleCount ?? 0;
    const onlyFullPage =
      existingPanels === 1 && pagePanels[0]?.source === "heuristic-fullpage";
    const fullPageRow = fullPagePanelRow(bookId, issueId, page.pageNumber);

    // Stored segmentation means Roboflow already ran on this page (#237).
    if (existingSeg > 0) {
      if (existingPanels === 0 || onlyFullPage) {
        await linkFullPagePanel(
          supabase,
          fullPageRow,
          existingPanels === 0,
          pageLabel,
        );
      }
      console.log(
        `[roboflow] ${pageLabel}: page_segmentation already present, skip Roboflow call`,
      );
      continue;
    }

    const imageUrl = pageImageUrl(bookId, issueId, page.pageNumber);

    const read = await readSam3Response(() =>
      runRoboflowWorkflow(workflowUrl, { type: "url", value: imageUrl }),
    );
    if ("failure" in read) {
      console.warn(`[roboflow] ${pageLabel}: SAM3 workflow ${read.failure}`);
      failedPageLabels.push(pageLabel);
      continue;
    }

    const {
      panelPredictions,
      image: imgDims,
      bubblePredictions,
      segmentationPredictions: segPreds,
    } = read.parsed;
    // Filter before the final map so sort_order and panel_id stay contiguous.
    const bubbleCenters = bubblePredictions.map((b) => ({
      x: b.x / imgDims.width,
      y: b.y / imgDims.height,
    }));
    const slivers = filterSliverPanels(
      mapPanelRows(
        bookId,
        issueId,
        page.pageNumber,
        panelPredictions,
        imgDims,
      ).map((row, idx) => ({
        idx,
        bounding_box: row.bounding_box as BoundingBoxJson,
      })),
      bubbleCenters,
    );
    const { kept, dropped: duplicates } = filterDuplicatePanels(
      slivers.kept,
      bubbleCenters,
    );
    for (const [kind, dropped] of [
      ["sliver", slivers.dropped],
      ["duplicate", duplicates],
    ] as const) {
      for (const { bounding_box: b } of dropped) {
        console.log(
          `[roboflow] ${pageLabel}: dropped ${kind} panel x ${b.x.toFixed(3)} y ${b.y.toFixed(3)} w ${b.w.toFixed(3)} h ${b.h.toFixed(3)}`,
        );
      }
    }
    const keptIdx = new Set(kept.map((c) => c.idx));
    const panelRows = mapPanelRows(
      bookId,
      issueId,
      page.pageNumber,
      panelPredictions.filter((_, idx) => keptIdx.has(idx)),
      imgDims,
    );
    const bubbleRows = mapBubbleRows(
      bookId,
      issueId,
      page.pageNumber,
      bubblePredictions,
    );
    const fullPage = existingPanels === 0 && panelRows.length === 0;

    if (existingPanels > 0) {
      console.log(
        `[roboflow] ${pageLabel}: ${existingPanels} panels already present, skip panels write`,
      );
    } else if (panelRows.length > 0) {
      const { error: pErr } = await supabase.from("panels").upsert(panelRows, {
        onConflict: "book_id,issue_id,panel_id",
        ignoreDuplicates: true,
      });
      if (pErr) {
        throw new FatalError(
          `panels upsert failed for ${pageLabel}: ${pErr.message}`,
        );
      }
    }

    if (existingBubbles > 0) {
      console.log(
        `[roboflow] ${pageLabel}: ${existingBubbles} bubbles already present, skip bubbles write`,
      );
    } else if (bubbleRows.length > 0) {
      const { error: bErr } = await supabase
        .from("bubbles")
        .upsert(bubbleRows, {
          onConflict: "book_id,issue_id,legacy_id",
          ignoreDuplicates: true,
        });
      if (bErr) {
        throw new FatalError(
          `bubbles upsert failed for ${pageLabel}: ${bErr.message}`,
        );
      }
    }

    const segRow = mapSegmentationRow(
      bookId,
      issueId,
      page.pageNumber,
      imgDims,
      segPreds,
    );
    const { error: sErr } = await supabase
      .from("page_segmentation")
      .upsert(segRow, {
        onConflict: "book_id,issue_id,page_number",
        ignoreDuplicates: true,
      });
    if (sErr) {
      throw new FatalError(
        `page_segmentation upsert failed for ${pageLabel}: ${sErr.message}`,
      );
    }
    // After the segmentation write, so a failure here is repaired by the
    // skip branch above on the next run, with no second Roboflow call.
    if (fullPage || onlyFullPage) {
      await linkFullPagePanel(supabase, fullPageRow, fullPage, pageLabel);
    }

    console.log(
      `[roboflow] ${bookId}/${issueId}: ${pageLabel} → ${fullPage ? "1 full-page" : panelRows.length} panels, ${bubbleRows.length} bubbles, ${segPreds.length} segments`,
    );

    await new Promise((r) => setTimeout(r, 750));
  }

  if (failedPageLabels.length > 0) {
    throw new FatalError(
      `[roboflow] page response failed or malformed: ${failedPageLabels.join(", ")}`,
    );
  }
}

export async function extractForegroundMasksBatch(
  bookId: string,
  issueId: string,
  pages: PageMeta[],
) {
  "use step";
  const { createTypedStepClient } = await import("../step-utils");
  const supabase = await createTypedStepClient();

  for (const page of pages) {
    const padded = String(page.pageNumber).padStart(2, "0");
    const pageLabel = `page-${padded}`;

    const { data: segRow, error: segErr } = await supabase
      .from("page_segmentation")
      .select("image_width, image_height, predictions")
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .eq("page_number", page.pageNumber)
      .maybeSingle();

    if (segErr) {
      throw new FatalError(
        `page_segmentation read failed for ${pageLabel}: ${segErr.message}`,
      );
    }

    if (!segRow) {
      console.log(`[masks] ${pageLabel}: no segmentation data, skip`);
      continue;
    }

    const { data: panels, error: panelsErr } = await supabase
      .from("panels")
      .select("id, bounding_box")
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .eq("page_number", page.pageNumber)
      .order("sort_order");

    if (panelsErr) {
      throw new FatalError(
        `panels read failed for ${pageLabel}: ${panelsErr.message}`,
      );
    }

    if (!panels || panels.length === 0) {
      console.log(`[masks] ${pageLabel}: no panels, skip`);
      continue;
    }

    const imgW = segRow.image_width;
    const imgH = segRow.image_height;
    const predictions = segRow.predictions as ForegroundPrediction[];

    const foreground = mapForegroundPolygons(
      panels.map((p) => ({ bounding_box: p.bounding_box as BoundingBoxJson })),
      { width: imgW, height: imgH },
      predictions,
    );

    let totalChars = 0;
    let totalBubbles = 0;
    for (const [i, p] of panels.entries()) {
      const { characters, bubbles } = foreground[i]!;
      totalChars += characters.length;
      totalBubbles += bubbles.length;
      if (characters.length === 0 && bubbles.length === 0) continue;
      const { error: updateErr } = await supabase
        .from("panels")
        .update({ foreground_polygons: { characters, bubbles } })
        .eq("id", p.id);
      if (updateErr) {
        throw new FatalError(
          `panels update failed for ${pageLabel}: ${updateErr.message}`,
        );
      }
    }

    console.log(
      `[masks] ${bookId}/${issueId}: page-${padded} → ${totalChars} character + ${totalBubbles} bubble polygon(s) across ${panels.length} panel(s)`,
    );
  }
}

export async function characterLookaheadPage(
  bookId: string,
  issueId: string,
  pageNumber: number,
) {
  "use step";
  const { createTypedStepClient } = await import("../step-utils");
  const supabase = await createTypedStepClient();

  const { getGeminiClient, getFallbackGeminiClient } = await import(
    "~/lib/gemini-client"
  );
  const { extractFaceCropsFromBuffer } = await import("~/lib/face-extraction");
  const { identifyFace } = await import("~/lib/character-identification");
  const exemplarStore = await import("~/lib/exemplar-store");
  const { withLlmMeta } = await import("~/lib/llm-usage");

  const gemini = getGeminiClient();
  const padded = String(pageNumber).padStart(2, "0");
  const pageLabel = `page-${padded}`;
  const llmMeta = {
    step: "character-lookahead",
    bookId,
    issueId,
    pageNumber,
  };

  // 1. Load segmentation predictions from DB
  const { data: segRow, error: segErr } = await supabase
    .from("page_segmentation")
    .select("image_width, image_height, predictions")
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("page_number", pageNumber)
    .maybeSingle();

  if (segErr) {
    throw new FatalError(
      `page_segmentation read failed for ${pageLabel}: ${segErr.message}`,
    );
  }

  if (!segRow) {
    console.log(`[lookahead] ${pageLabel}: no segmentation, skip`);
    return;
  }

  const predictions = segRow.predictions as Array<{
    class: string;
    confidence: number;
    points: Array<{ x: number; y: number }>;
  }>;

  const hasFaces = predictions.some(
    (p) => (p.class === "face" || p.class === "head") && p.points.length >= 3,
  );
  if (!hasFaces) {
    console.log(`[lookahead] ${pageLabel}: no faces detected, skip`);
    return;
  }

  // 2. Load panels from DB; skip a page whose faces are already stored
  const { data: panels, error: panelsErr } = await supabase
    .from("panels")
    .select("id, bounding_box, sort_order")
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("page_number", pageNumber)
    .order("sort_order");

  if (panelsErr) {
    throw new FatalError(
      `panels read failed for ${pageLabel}: ${panelsErr.message}`,
    );
  }

  if (!panels || panels.length === 0) return;

  if (
    await hasStoredFaceDetections(
      supabase,
      panels.map((p) => p.id),
      pageLabel,
    )
  ) {
    console.log(
      `[lookahead] ${pageLabel}: face detections already stored, skip`,
    );
    return;
  }

  // 3. Download page image from Storage
  const storagePath = pageStoragePath(bookId, issueId, pageNumber);
  const { data: imageBlob, error: downloadErr } = await supabase.storage
    .from("comic-pages")
    .download(storagePath);

  if (downloadErr) {
    throw new FatalError(
      `comic-pages download failed for ${pageLabel}: ${downloadErr.message}`,
    );
  }

  if (!imageBlob) {
    console.log(`[lookahead] ${pageLabel}: image not found, skip`);
    return;
  }

  const imgBuf = Buffer.from(await imageBlob.arrayBuffer());
  const meta = await sharp(imgBuf).metadata();
  const imgW = meta.width ?? 0;
  const imgH = meta.height ?? 0;
  if (imgW === 0 || imgH === 0) return;

  const panelRects = panels.map((p) => {
    const bb = p.bounding_box as BoundingBoxJson;
    return {
      id: p.id,
      x: bb.x * imgW,
      y: bb.y * imgH,
      w: bb.w * imgW,
      h: bb.h * imgH,
    };
  });

  // 4. Extract face crops with deduplication
  const faceCrops = await extractFaceCropsFromBuffer(
    imgBuf,
    predictions,
    panelRects,
  );

  if (faceCrops.length === 0) {
    console.log(`[lookahead] ${pageLabel}: no valid face crops, skip`);
    return;
  }

  // 5. Build known character list + wiki context
  const dbCharacters = await buildKnownCharacterListOrFatal(
    supabase,
    bookId,
    pageLabel,
  );

  const { data: issueRow, error: issueErr } = await selectIssue(
    supabase,
    bookId,
    issueId,
    "wiki_summary, wiki_appearances",
  ).single();

  if (issueErr) {
    throw new FatalError(
      `issues read failed for ${pageLabel}: ${issueErr.message}`,
    );
  }

  type WikiAppearance = { name: string; qualifier?: string };
  const wikiAppearances =
    (issueRow?.wiki_appearances as WikiAppearance[] | null) ?? [];

  const dbNormalized = new Set(
    dbCharacters.map((n) =>
      n.toLowerCase().replace(/[-_]/g, " ").replace(/\s+/g, " ").trim(),
    ),
  );

  const wikiNames: string[] = [];
  for (const a of wikiAppearances) {
    const baseName = a.name;
    const norm = baseName
      .toLowerCase()
      .replace(/[-_]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (dbNormalized.has(norm)) continue;
    const firstLast = norm.split(" ");
    if (
      firstLast.length >= 2 &&
      [...dbNormalized].some((db) => {
        const dbWords = db.split(" ");
        return (
          dbWords.length >= 2 &&
          dbWords[0] === firstLast[0] &&
          dbWords[dbWords.length - 1] === firstLast[firstLast.length - 1]
        );
      })
    ) {
      continue;
    }
    wikiNames.push(a.qualifier ? `${baseName} (${a.qualifier})` : baseName);
  }

  const knownCharacters = [...new Set([...dbCharacters, ...wikiNames])];
  const wikiSummary =
    (issueRow?.wiki_summary as string | undefined) ?? undefined;

  // 6. Identify each face with exemplar context
  const detectionRows: Array<{
    character_id: string | null;
    suggested_name?: string;
    panel_id: string;
    face_bbox: Json;
    identification_confidence: number;
  }> = [];

  const pageBase64 = imgBuf.toString("base64");

  for (const face of faceCrops) {
    // Retrieve similar exemplars from pgvector
    const exemplarRefs = await withLlmMeta(llmMeta, () =>
      exemplarRefsOrFatal(
        exemplarStore,
        supabase,
        face.jpegBuffer.toString("base64"),
        bookId,
        pageLabel,
      ),
    );

    // Identify with exemplar context + key failover
    const faceBase64 = face.jpegBuffer.toString("base64");
    const result = await withLlmMeta(llmMeta, () =>
      identifyFaceOrFatal(
        (client) =>
          identifyFace(
            client,
            faceBase64,
            "image/jpeg",
            knownCharacters,
            exemplarRefs,
            pageBase64,
            "image/webp",
            wikiSummary,
            { throwOnApiError: true },
          ),
        gemini,
        getFallbackGeminiClient,
        pageLabel,
      ),
    );

    if (result.characterName && result.confidence >= 0.6) {
      const charId = await resolveCharacterIdOrFatal(
        supabase,
        result.characterName,
        pageLabel,
      );

      detectionRows.push({
        character_id: charId,
        suggested_name: charId ? undefined : result.characterName,
        panel_id: face.panelId,
        face_bbox: face.bboxPanelLocal,
        identification_confidence: result.confidence,
      });

      // Store face as exemplar (confirmed if resolved + high confidence)
      if (result.confidence >= 0.7) {
        const suggestedName = charId ? undefined : result.characterName;
        try {
          await withLlmMeta(llmMeta, () =>
            exemplarStore.storeExemplar(supabase, {
              jpegBuffer: face.jpegBuffer,
              characterId: charId,
              suggestedName,
              bookId,
              sourceIssue: issueId,
              pageNumber,
              confidence: result.confidence,
              isConfirmed: charId !== null && result.confidence >= 0.9,
            }),
          );
        } catch (e) {
          throw new FatalError(
            `character_face_exemplars write failed for ${pageLabel}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }

    // Rate limit delay between faces
    await new Promise((r) => setTimeout(r, 800));
  }

  if (detectionRows.length > 0) {
    const panelIdsInBatch = [...new Set(detectionRows.map((r) => r.panel_id))];
    const { data: existingDets, error: existingErr } = await supabase
      .from("panel_character_detections")
      .select("character_id, suggested_name, panel_id")
      .in("panel_id", panelIdsInBatch);

    if (existingErr) {
      throw new FatalError(
        `panel_character_detections read failed for ${pageLabel}: ${existingErr.message}`,
      );
    }

    const existingKeys = new Set(
      (existingDets ?? []).map(
        (d: {
          character_id: string | null;
          suggested_name: string | null;
          panel_id: string;
        }) => `${d.character_id ?? d.suggested_name}::${d.panel_id}`,
      ),
    );

    const newRows = detectionRows.filter(
      (r) =>
        !existingKeys.has(
          `${r.character_id ?? r.suggested_name}::${r.panel_id}`,
        ),
    );

    if (newRows.length > 0) {
      const { error } = await supabase
        .from("panel_character_detections")
        .insert(newRows);
      if (error) {
        throw new FatalError(
          `panel_character_detections insert failed for ${pageLabel}: ${error.message}`,
        );
      }
    }
  }

  console.log(
    `[lookahead] ${bookId}/${issueId}: ${pageLabel} → ${faceCrops.length} faces, ${detectionRows.length} identified`,
  );
}

export async function getContextPage(
  bookId: string,
  issueId: string,
  pageNumber: number,
) {
  "use step";
  const { createTypedStepClient } = await import("../step-utils");
  const supabase = await createTypedStepClient();

  const geminiKey = process.env.GEMINI_API_KEY;
  const roboflowKey = process.env.ROBOFLOW_API_KEY;
  const roboflowUrl = process.env.ROBOFLOW_WORKFLOW_URL;
  if (!geminiKey || !roboflowKey || !roboflowUrl) {
    throw new FatalError(
      "GEMINI_API_KEY, ROBOFLOW_API_KEY, and ROBOFLOW_WORKFLOW_URL required",
    );
  }

  const { getGeminiClient: getGemini } = await import("~/lib/gemini-client");
  const { runRoboflowWorkflow } = await import("~/lib/roboflow-client");
  const gemini = getGemini();
  const { GEMINI_HIGH } = await import("~/lib/models");
  const { generateContentLogged } = await import("~/lib/llm-usage");

  const padded = String(pageNumber).padStart(2, "0");
  const pageLabel = `page-${padded}`;
  const llmMeta = { step: "get-context", bookId, issueId, pageNumber };

  // Load book + wiki context for richer prompts
  let bookContext: string | undefined;
  const [
    { data: bookRow, error: bookErr },
    { data: issueRow, error: issueErr },
  ] = await Promise.all([
    supabase.from("books").select("name, franchises").eq("id", bookId).single(),
    selectIssue(
      supabase,
      bookId,
      issueId,
      "wiki_summary, wiki_appearances",
    ).single(),
  ]);
  if (bookErr) {
    throw new FatalError(
      `books read failed for ${pageLabel}: ${bookErr.message}`,
    );
  }
  if (issueErr) {
    throw new FatalError(
      `issues read failed for ${pageLabel}: ${issueErr.message}`,
    );
  }
  {
    const parts: string[] = [];
    if (bookRow) {
      const bookName = bookRow.name;
      const franchises = bookRow.franchises;
      if (bookName) parts.push(`Book: ${bookName}`);
      if (franchises?.length)
        parts.push(`Franchises: ${franchises.join(", ")}`);
    }
    if (issueRow?.wiki_summary) {
      parts.push(`\nIssue Synopsis:\n${issueRow.wiki_summary}`);
    }
    if (issueRow?.wiki_appearances) {
      type AppEntry = { name: string; qualifier?: string };
      const appearances = issueRow.wiki_appearances as AppEntry[];
      const names = appearances.map((a) =>
        a.qualifier ? `${a.name} (${a.qualifier})` : a.name,
      );
      parts.push(`\nKnown Characters in this issue:\n${names.join(", ")}`);
    }
    parts.push(
      "Use your knowledge of comics and pop culture to identify characters by their proper canonical names where possible.",
    );
    bookContext = parts.join("\n");
  }

  const storagePath = pageStoragePath(bookId, issueId, pageNumber);
  const { data: imageBlob, error: downloadErr } = await supabase.storage
    .from("comic-pages")
    .download(storagePath);

  if (downloadErr) {
    throw new FatalError(
      `comic-pages download failed for ${pageLabel}: ${downloadErr.message}`,
    );
  }

  if (!imageBlob) {
    console.warn(`[context] ${pageLabel}: image not found, skip`);
    return;
  }

  const imgBuf = Buffer.from(await imageBlob.arrayBuffer());

  const bubbleSelect =
    "id, legacy_id, box_2d, ocr_text, text_with_cues, speaker, ignored";

  const { data: initialBubbles, error: bubblesErr } = await supabase
    .from("bubbles")
    .select(bubbleSelect)
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("page_number", pageNumber);

  if (bubblesErr) {
    throw new FatalError(
      `bubbles read failed for ${pageLabel}: ${bubblesErr.message}`,
    );
  }

  let bubbleData = initialBubbles ?? [];

  if (bubbleData.length === 0) {
    const base64Image = imgBuf.toString("base64");
    const preds = await roboflowTextPredictionsOrFatal(
      () =>
        runRoboflowWorkflow(roboflowUrl, {
          type: "base64",
          value: base64Image,
        }),
      pageLabel,
    );
    if (preds.length === 0) {
      console.log(`[context] ${pageLabel}: no text regions found`);
      return;
    }

    const newBubbles = mapBubbleRows(bookId, issueId, pageNumber, preds);

    const { error: upsertErr } = await supabase
      .from("bubbles")
      .upsert(newBubbles, {
        onConflict: "book_id,issue_id,legacy_id",
        ignoreDuplicates: true,
      });
    if (upsertErr) {
      throw new FatalError(
        `bubbles upsert failed for ${pageLabel}: ${upsertErr.message}`,
      );
    }

    const { data: requeried, error: requeryErr } = await supabase
      .from("bubbles")
      .select(bubbleSelect)
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .eq("page_number", pageNumber);

    if (requeryErr) {
      throw new FatalError(
        `bubbles read failed for ${pageLabel}: ${requeryErr.message}`,
      );
    }

    if (!requeried || requeried.length === 0) return;
    bubbleData = requeried;
  }

  const { data: pagePanels, error: pagePanelsErr } = await supabase
    .from("panels")
    .select("id, page_number")
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("page_number", pageNumber);

  if (pagePanelsErr) {
    throw new FatalError(
      `panels read failed for ${pageLabel}: ${pagePanelsErr.message}`,
    );
  }

  const pageCharNames: string[] = [];
  if (pagePanels && pagePanels.length > 0) {
    const panelIds = pagePanels.map((p) => p.id);
    const { data: detections, error: detsErr } = await supabase
      .from("panel_character_detections")
      .select("character_id")
      .in("panel_id", panelIds);

    if (detsErr) {
      throw new FatalError(
        `panel_character_detections read failed for ${pageLabel}: ${detsErr.message}`,
      );
    }

    if (detections) {
      for (const d of detections) {
        if (d.character_id == null) continue;
        const name = d.character_id.replace(/-/g, " ");
        if (!pageCharNames.includes(name)) pageCharNames.push(name);
      }
    }
  }

  type BubbleRow = {
    id: string;
    legacy_id: string;
    box_2d: { x: number; y: number; width: number; height: number };
    ocr_text: string | null;
    text_with_cues: string | null;
    speaker: string | null;
    ignored: boolean | null;
  };

  const allBubbles = bubbleData as BubbleRow[];
  const bubbles = allBubbles.filter((b) => !bubbleHasContext(b));
  if (allBubbles.length > 0 && bubbles.length === 0) {
    console.log(
      `[context] ${pageLabel}: all bubbles already have context, skip`,
    );
    return;
  }

  const uniqueSpeakers: string[] = [];

  for (const bubble of bubbles) {
    const box = bubble.box_2d;
    if (!box?.width || !box.height) continue;

    let ocrText = "";
    try {
      const { createPartFromBase64: cpb64, createPartFromText: cpt } =
        await import("@google/genai");
      const cropBuf = await sharp(imgBuf)
        .extract({
          left: Math.max(0, box.x),
          top: Math.max(0, box.y),
          width: box.width,
          height: box.height,
        })
        .toBuffer();

      const ocrImagePart = cpb64(cropBuf.toString("base64"), "image/webp");
      const ocrPrompt = cpt(
        "Extract all text from this comic book speech bubble. Return ONLY the text exactly as it appears. No explanation or formatting.",
      );

      const ocrResponse = await generateContentLogged(
        gemini,
        { model: GEMINI_MEDIUM, contents: [ocrImagePart, ocrPrompt] },
        llmMeta,
      );

      ocrText = ocrResponse.text?.trim() ?? "";
    } catch {
      console.warn(
        `[context] ${pageLabel} bubble ${bubble.legacy_id}: OCR failed`,
      );
      continue;
    }

    if (!ocrText) continue;

    const allCharacters = [...pageCharNames, ...uniqueSpeakers].filter(
      (name, i, arr) => arr.indexOf(name) === i,
    );

    const { buildContextPrompt } = await import("~/lib/gemini-prompts");
    const contextPrompt = buildContextPrompt(
      ocrText,
      box,
      allCharacters,
      bookContext,
    );

    try {
      const { createPartFromBase64: cpb64, createPartFromText: cpt } =
        await import("@google/genai");
      const pageImagePart = cpb64(imgBuf.toString("base64"), "image/webp");
      const contextTextPart = cpt(contextPrompt);

      const contextResponse = await generateContentLogged(
        gemini,
        { model: GEMINI_HIGH, contents: [pageImagePart, contextTextPart] },
        llmMeta,
      );

      const responseText = contextResponse.text?.trim() ?? "";

      // Extract scratchpad reasoning if present
      const scratchpadMatch = /<scratchpad>([\s\S]*?)<\/scratchpad>/.exec(
        responseText,
      );
      const aiReasoning = scratchpadMatch?.[1]?.trim() ?? null;

      const jsonMatch = /\{[\s\S]*\}/.exec(responseText);
      if (!jsonMatch) continue;

      const parsed = JSON.parse(jsonMatch[0]) as ContextParsed;
      const update = buildContextUpdate(parsed, ocrText, aiReasoning);
      const speaker = update.speaker ?? null;

      if (speaker && !uniqueSpeakers.includes(speaker)) {
        uniqueSpeakers.push(speaker);
      }

      const { error: updateErr } = await supabase
        .from("bubbles")
        .update(update)
        .eq("id", bubble.id)
        .is("ocr_text", null)
        .is("text_with_cues", null)
        .is("speaker", null);
      if (updateErr) {
        throw new FatalError(
          `bubbles update failed for ${pageLabel}: ${updateErr.message}`,
        );
      }
    } catch (e) {
      if (e instanceof FatalError) throw e;
      console.warn(
        `[context] ${pageLabel} bubble ${bubble.legacy_id}: context analysis failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log(
    `[context] ${bookId}/${issueId}: ${pageLabel} → ${bubbles.length} bubbles processed, ${uniqueSpeakers.length} speakers found`,
  );
}

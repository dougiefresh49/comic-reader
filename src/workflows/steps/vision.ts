import type { SupabaseClient } from "@supabase/supabase-js";
import sharp from "sharp";
import { FatalError } from "workflow";
import { GEMINI_MEDIUM } from "~/lib/models";
import { filterDuplicateBubbles } from "~/lib/bubble-filter";
import {
  bubbleCenter,
  filterDuplicatePanels,
  filterSliverPanels,
  matchBubblePanel,
} from "~/lib/panel-filter";
import { pageImageUrl, pageStoragePath } from "~/lib/storage";
import type { Database, Json, TablesInsert } from "~/types/database";
import type { PageMeta, BoundingBoxJson } from "./shared";
import {
  bubbleHasContext,
  buildContextUpdate,
  closedCastLines,
  CLOSED_CAST_NOTES,
  contextSpeakerReply,
  mapBubbleRows,
  mapForegroundPolygons,
  mapPanelRows,
  mapSegmentationRow,
  normalizePanelAudioTags,
  parseRoboflowSam3Output,
  resolveContext,
  type ClosedCastMember,
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
import type {
  FaceIdentification,
  FaceOutcome,
} from "~/lib/character-identification";
import type { FaceCropResult } from "~/lib/face-extraction";
import { groupFaces } from "~/lib/face-groups";

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
 * `panel_character_detections` row. That insert is one statement, a failed
 * face is fatal before it (`identifyFaceOrFatal`), and an exemplar write
 * that throws after it deletes it again (`storeLookaheadFacesOrFatal`), so
 * such a page has no detections and runs again. Two ways leave a page
 * half-stored, keeping its detections, missing exemplars, and skipped from
 * then on: a hard stop (step timeout, process kill) between the insert and
 * the last exemplar, and an undo whose exemplar row delete or detection
 * delete fails.
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
 * Similar stored faces for one crop, given as a JPEG in base64 or as its
 * embedding. The embedding already retries a 429 on the fallback key
 * (`~/lib/embeddings`), so anything that reaches here is fatal for the page.
 * The store is passed in: an import here would pull Node-only modules into
 * the workflow bundle.
 */
export async function exemplarRefsOrFatal(
  { findSimilarExemplars, downloadExemplarImage }: ExemplarStore,
  supabase: TypedClient,
  face: string | number[],
  bookId: string,
  pageLabel: string,
): Promise<ExemplarRef[]> {
  try {
    const matches = await findSimilarExemplars(supabase, face, [bookId], 3);
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

/**
 * Link the page's unlinked bubbles to its panels with the backfill-panels
 * matcher (#306). `image` is the pixel size `box_2d` is measured in; without
 * it the pages row is read, and with neither the page is skipped. A bubble
 * already linked (full-page panel, review, apply-fixes) is never touched.
 */
async function linkBubblesToPanels(
  supabase: TypedClient,
  bookId: string,
  issueId: string,
  pageNumber: number,
  pageLabel: string,
  image: { width: number; height: number } | null,
) {
  const { data: bubbles, error: bErr } = await supabase
    .from("bubbles")
    .select("id, box_2d")
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("page_number", pageNumber)
    .is("panel_id", null);
  if (bErr) {
    throw new FatalError(
      `unlinked bubbles read failed for ${pageLabel}: ${bErr.message}`,
    );
  }
  if (bubbles.length === 0) return;

  const { data: panels, error: pErr } = await supabase
    .from("panels")
    .select("id, bounding_box")
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("page_number", pageNumber);
  if (pErr) {
    throw new FatalError(
      `panels read failed for ${pageLabel}: ${pErr.message}`,
    );
  }
  if (panels.length === 0) return;

  let size = image;
  if (!size) {
    const { data: pageRow, error: sizeErr } = await supabase
      .from("pages")
      .select("width, height")
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .eq("number", pageNumber)
      .maybeSingle();
    if (sizeErr) {
      throw new FatalError(
        `pages read failed for ${pageLabel}: ${sizeErr.message}`,
      );
    }
    size = pageRow;
  }
  if (!size || !(size.width > 0) || !(size.height > 0)) {
    console.warn(
      `[link] ${pageLabel}: no image size, ${bubbles.length} bubbles left unlinked`,
    );
    return;
  }

  const boxed = panels.map((p) => ({
    id: p.id,
    bounding_box: p.bounding_box as BoundingBoxJson,
  }));
  let linked = 0;
  let noBox = 0;
  for (const bubble of bubbles) {
    const center = bubbleCenter(bubble.box_2d, size);
    const { panel } = center
      ? matchBubblePanel(center, boxed)
      : { panel: null };
    if (!panel) {
      noBox++;
      continue;
    }
    const { data, error } = await supabase
      .from("bubbles")
      .update({ panel_id: panel.id })
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .eq("page_number", pageNumber)
      .eq("id", bubble.id)
      .is("panel_id", null)
      .select("id");
    if (error) {
      throw new FatalError(
        `bubble panel link failed for ${pageLabel}: ${error.message}`,
      );
    }
    linked += data.length;
  }
  console.log(
    `[link] ${pageLabel}: ${linked} bubbles linked to panels, ${noBox} left unlinked with no usable box_2d`,
  );
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
      // A rerun links rows already in the DB; page is the pages row.
      await linkBubblesToPanels(
        supabase,
        bookId,
        issueId,
        page.pageNumber,
        pageLabel,
        page,
      );
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
      bubblePredictions: rawBubbles,
      segmentationPredictions: segPreds,
    } = read.parsed;
    // One box per balloon (#311), before the panel filters see the centers.
    const bubbleFilter = filterDuplicateBubbles(
      rawBubbles.map((b, idx) => ({
        idx,
        confidence: b.confidence,
        bounding_box: {
          x: b.x - b.width / 2,
          y: b.y - b.height / 2,
          w: b.width,
          h: b.height,
        },
      })),
    );
    for (const { bounding_box: b, confidence } of bubbleFilter.dropped) {
      console.log(
        `[roboflow] ${pageLabel}: dropped duplicate bubble x ${Math.round(b.x)} y ${Math.round(b.y)} w ${Math.round(b.w)} h ${Math.round(b.h)} conf ${confidence.toFixed(3)}`,
      );
    }
    const keptBubbleIdx = new Set(bubbleFilter.kept.map((c) => c.idx));
    const bubblePredictions = rawBubbles.filter((_, idx) =>
      keptBubbleIdx.has(idx),
    );
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
    await linkBubblesToPanels(
      supabase,
      bookId,
      issueId,
      page.pageNumber,
      pageLabel,
      imgDims,
    );

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

/** Where a face sits, for a stable group numbering across the issue. */
export type FacePosition = {
  pageNumber: number;
  panelSort: number;
  x: number;
  y: number;
};

export function compareFacePosition(a: FacePosition, b: FacePosition) {
  return (
    a.pageNumber - b.pageNumber ||
    a.panelSort - b.panelSort ||
    a.y - b.y ||
    a.x - b.x
  );
}

/**
 * The Node-only modules the lookahead helpers use, imported by the caller
 * (the step, or the #348 dry run): an import in a helper would pull them
 * into the workflow bundle.
 */
export type LookaheadDeps = {
  imageLib: typeof import("sharp");
  faceExtraction: typeof import("~/lib/face-extraction");
  characterIdentification: typeof import("~/lib/character-identification");
  exemplarStore: typeof import("~/lib/exemplar-store");
  llmUsage: typeof import("~/lib/llm-usage");
  geminiClient: typeof import("~/lib/gemini-client");
};

export type LookaheadPage = {
  pageNumber: number;
  pageLabel: string;
  imgBuf: Buffer;
  crops: FaceCropResult[];
  panelSort: Map<string, number>;
};

/**
 * One page's face crops, cut from its stored `page_segmentation` row: no
 * Roboflow call and no Gemini call. `skipIfStored` is the step's rerun
 * check; the #348 dry run turns it off.
 */
export async function loadLookaheadPageOrFatal(
  { imageLib, faceExtraction }: LookaheadDeps,
  supabase: TypedClient,
  bookId: string,
  issueId: string,
  pageNumber: number,
  { skipIfStored }: { skipIfStored: boolean },
): Promise<LookaheadPage | { skip: string; stored?: true }> {
  const { extractFaceCropsFromBuffer } = faceExtraction;
  const pageLabel = `page-${String(pageNumber).padStart(2, "0")}`;

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

  if (!segRow) return { skip: "no segmentation" };

  const predictions = segRow.predictions as Array<{
    class: string;
    confidence: number;
    points: Array<{ x: number; y: number }>;
  }>;

  const hasFaces = predictions.some(
    (p) => (p.class === "face" || p.class === "head") && p.points.length >= 3,
  );
  if (!hasFaces) return { skip: "no faces detected" };

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

  if (!panels || panels.length === 0) return { skip: "no panels" };

  if (
    skipIfStored &&
    (await hasStoredFaceDetections(
      supabase,
      panels.map((p) => p.id),
      pageLabel,
    ))
  ) {
    return { skip: "face detections already stored", stored: true };
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

  if (!imageBlob) return { skip: "image not found" };

  const imgBuf = Buffer.from(await imageBlob.arrayBuffer());
  const meta = await imageLib(imgBuf).metadata();
  const imgW = meta.width ?? 0;
  const imgH = meta.height ?? 0;
  if (imgW === 0 || imgH === 0) return { skip: "image has no size" };

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
  const crops = await extractFaceCropsFromBuffer(
    imgBuf,
    predictions,
    panelRects,
  );

  if (crops.length === 0) return { skip: "no valid face crops" };

  return {
    pageNumber,
    pageLabel,
    imgBuf,
    crops,
    panelSort: new Map(panels.map((p) => [p.id, p.sort_order])),
  };
}

export type IdentifiedFace = {
  crop: FaceCropResult;
  position: FacePosition;
  /** Computed once per crop: the exemplar lookup and the stored row share it. */
  embedding: number[];
  result: FaceIdentification;
  outcome: FaceOutcome;
  /** The resolved character for a named face, else null. */
  characterId: string | null;
};

/**
 * One embedding and one Gemini naming call per crop, plus reads. Writes
 * nothing but the `llm_calls` rows the Gemini wrapper logs, so the #348 dry
 * run calls it as the step does.
 */
export async function identifyLookaheadFacesOrFatal(
  deps: LookaheadDeps,
  supabase: TypedClient,
  bookId: string,
  issueId: string,
  page: LookaheadPage,
  step = "character-lookahead",
): Promise<IdentifiedFace[]> {
  const { getGeminiClient, getFallbackGeminiClient } = deps.geminiClient;
  const { identifyFace, faceOutcome } = deps.characterIdentification;
  const { exemplarStore } = deps;
  const { withLlmMeta } = deps.llmUsage;

  const gemini = getGeminiClient();
  const { pageNumber, pageLabel, imgBuf } = page;
  const llmMeta = { step, bookId, issueId, pageNumber };

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
  const pageBase64 = imgBuf.toString("base64");
  const faces: IdentifiedFace[] = [];

  for (const crop of page.crops) {
    const faceBase64 = crop.jpegBuffer.toString("base64");
    let embedding: number[];
    try {
      embedding = await withLlmMeta(llmMeta, () =>
        exemplarStore.embedFace(faceBase64),
      );
    } catch (err: unknown) {
      throw new FatalError(
        `face embedding failed for ${pageLabel}: ${errorText(err)}`,
      );
    }

    // Retrieve similar exemplars from pgvector
    const exemplarRefs = await exemplarRefsOrFatal(
      exemplarStore,
      supabase,
      embedding,
      bookId,
      pageLabel,
    );

    // Identify with exemplar context + key failover
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

    const outcome = faceOutcome(result);
    const characterId =
      outcome === "named" && result.characterName
        ? await resolveCharacterIdOrFatal(
            supabase,
            result.characterName,
            pageLabel,
          )
        : null;

    faces.push({
      crop,
      position: {
        pageNumber,
        panelSort: page.panelSort.get(crop.panelId) ?? 0,
        x: crop.bboxPanelLocal.x,
        y: crop.bboxPanelLocal.y,
      },
      embedding,
      result,
      outcome,
      characterId,
    });

    // Rate limit delay between faces
    await new Promise((r) => setTimeout(r, 800));
  }

  return faces;
}

/** A named face's exemplar is stored at this confidence or more (as before). */
const NAMED_EXEMPLAR_MIN_CONFIDENCE = 0.7;

/**
 * Detections first, in one insert, then the exemplars that carry their
 * `detection_id` (#348). A failed exemplar undoes this call's detections and
 * the exemplars cut from them, so the page has no detections and a rerun does
 * it again (`hasStoredFaceDetections`). When the undo cannot delete those
 * exemplar rows it keeps the detections too, and when the detection delete
 * fails they stay; either way the page stays half-stored. A failed Storage
 * remove alone does not stop the undo; the FatalError names the orphaned crops.
 */
async function storeLookaheadFacesOrFatal(
  { exemplarStore }: LookaheadDeps,
  supabase: TypedClient,
  bookId: string,
  issueId: string,
  page: LookaheadPage,
  faces: IdentifiedFace[],
): Promise<{ named: number; unnamed: number }> {
  const { storeExemplar, deleteExemplars } = exemplarStore;
  const { pageNumber, pageLabel } = page;
  const kept = faces.filter((f) => f.outcome !== "drop");
  const named = kept.filter((f) => f.outcome === "named").length;
  if (kept.length === 0) return { named, unnamed: 0 };

  const panelIds = [...new Set(kept.map((f) => f.crop.panelId))];
  const { data: existingDets, error: existingErr } = await supabase
    .from("panel_character_detections")
    .select("id, character_id, suggested_name, panel_id")
    .in("panel_id", panelIds);

  if (existingErr) {
    throw new FatalError(
      `panel_character_detections read failed for ${pageLabel}: ${existingErr.message}`,
    );
  }

  // As before, a named face reuses a detection already stored for its
  // character on its panel; within this batch every crop gets its own row.
  // An unnamed face has no key.
  const namedKey = (name: string | null, panelId: string) =>
    `${name}::${panelId}`;
  const detectionByKey = new Map<string, string>();
  for (const d of existingDets ?? []) {
    const name = d.character_id ?? d.suggested_name;
    if (name !== null) detectionByKey.set(namedKey(name, d.panel_id), d.id);
  }

  const newRows: TablesInsert<"panel_character_detections">[] = [];
  const detectionIds: string[] = [];
  for (const f of kept) {
    const suggestedName =
      f.outcome === "named" && !f.characterId ? f.result.characterName : null;
    const key =
      f.outcome === "named"
        ? namedKey(f.characterId ?? suggestedName, f.crop.panelId)
        : null;
    const existing = key ? detectionByKey.get(key) : undefined;
    if (existing) {
      detectionIds.push(existing);
      continue;
    }
    const id = crypto.randomUUID();
    newRows.push({
      id,
      character_id: f.characterId,
      suggested_name: suggestedName,
      panel_id: f.crop.panelId,
      face_bbox: f.crop.bboxPanelLocal,
      identification_confidence: f.result.confidence,
    });
    detectionIds.push(id);
  }

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

  const newIds = newRows.map((r) => r.id!);
  try {
    for (const [i, f] of kept.entries()) {
      const unnamed = f.outcome === "unnamed";
      if (!unnamed && f.result.confidence < NAMED_EXEMPLAR_MIN_CONFIDENCE) {
        continue;
      }
      await storeExemplar(supabase, {
        jpegBuffer: f.crop.jpegBuffer,
        characterId: f.characterId,
        suggestedName:
          unnamed || f.characterId
            ? undefined
            : (f.result.characterName ?? undefined),
        bookId,
        sourceIssue: issueId,
        pageNumber,
        confidence: f.result.confidence,
        isConfirmed:
          !unnamed && f.characterId !== null && f.result.confidence >= 0.9,
        detectionId: detectionIds[i],
        embedding: f.embedding,
      });
    }
  } catch (e) {
    // An exemplar carrying one of this call's new detection ids is one this
    // call created: delete those first. The detections go only after that
    // succeeds, since their delete would null a surviving exemplar's
    // detection_id and leave it for the rerun's dedupe.
    const undo: string[] = [];
    let rowsDeleted = false;
    try {
      const storageErr = await deleteExemplars(supabase, newIds);
      rowsDeleted = true;
      if (storageErr) undo.push(storageErr);
    } catch (undoErr: unknown) {
      undo.push(
        `exemplar rows not deleted, so exemplars and detections are left as stored and the page is skipped from now on: ${errorText(undoErr)}`,
      );
    }
    if (rowsDeleted && newIds.length > 0) {
      const { error } = await supabase
        .from("panel_character_detections")
        .delete()
        .in("id", newIds);
      if (error) {
        undo.push(
          `detections not deleted, so the page is skipped from now on: ${error.message}`,
        );
      }
    }
    throw new FatalError(
      `character_face_exemplars write failed for ${pageLabel}: ${errorText(e)}${undo.length > 0 ? `; undo: ${undo.join("; ")}` : ""}`,
    );
  }

  return { named, unnamed: kept.length - named };
}

/**
 * Groups every unnamed face in the issue by embedding (`groupFaces`) and
 * writes the group to `cluster_id`, a group of one included (#348). Each run
 * regroups the whole issue, so the last page's run leaves the final grouping;
 * only rows whose group changed are written. A page skipped as stored
 * regroups too, which repairs a run that failed partway through these writes.
 */
async function groupUnnamedFacesOrFatal(
  supabase: TypedClient,
  bookId: string,
  issueId: string,
  pageLabel: string,
): Promise<{ faces: number; groups: number; updated: number } | null> {
  const fail = (what: string, message: string) =>
    new FatalError(`${what} failed for ${pageLabel} (face groups): ${message}`);

  const {
    data: dets,
    error: detsErr,
    count: detsCount,
  } = await supabase
    .from("panel_character_detections")
    .select(
      "id, cluster_id, face_bbox, panels!inner(book_id, issue_id, page_number, sort_order)",
      { count: "exact" },
    )
    .eq("panels.book_id", bookId)
    .eq("panels.issue_id", issueId)
    .is("character_id", null)
    .is("suggested_name", null);
  if (detsErr) throw fail("panel_character_detections read", detsErr.message);
  if ((detsCount ?? 0) > dets.length) {
    throw fail(
      "panel_character_detections read",
      `got ${dets.length} of ${detsCount} rows`,
    );
  }
  if (dets.length === 0) return null;

  const {
    data: exemplars,
    error: exErr,
    count: exCount,
  } = await supabase
    .from("character_face_exemplars")
    .select("detection_id, embedding", { count: "exact" })
    .eq("book_id", bookId)
    .eq("source_issue", issueId)
    .is("character_id", null)
    .is("suggested_name", null)
    .not("detection_id", "is", null);
  if (exErr) throw fail("character_face_exemplars read", exErr.message);
  if ((exCount ?? 0) > exemplars.length) {
    throw fail(
      "character_face_exemplars read",
      `got ${exemplars.length} of ${exCount} rows`,
    );
  }

  const embeddingOf = new Map<string, number[]>();
  for (const e of exemplars) {
    if (e.detection_id && e.embedding && !embeddingOf.has(e.detection_id)) {
      embeddingOf.set(e.detection_id, JSON.parse(e.embedding) as number[]);
    }
  }

  const ordered = dets
    .map((d) => {
      const bb = d.face_bbox as BoundingBoxJson;
      return {
        id: d.id,
        clusterId: d.cluster_id,
        position: {
          pageNumber: d.panels.page_number,
          panelSort: d.panels.sort_order,
          x: bb.x,
          y: bb.y,
        },
      };
    })
    .sort((a, b) => compareFacePosition(a.position, b.position));

  const groups = groupFaces(ordered.map((d) => embeddingOf.get(d.id) ?? null));

  const changed = new Map<number, string[]>();
  ordered.forEach((d, i) => {
    const g = groups[i]!;
    if (d.clusterId !== g) changed.set(g, [...(changed.get(g) ?? []), d.id]);
  });
  let updated = 0;
  for (const [clusterId, ids] of changed) {
    const { error } = await supabase
      .from("panel_character_detections")
      .update({ cluster_id: clusterId })
      .in("id", ids);
    if (error) throw fail("panel_character_detections update", error.message);
    updated += ids.length;
  }

  return { faces: ordered.length, groups: Math.max(...groups), updated };
}

export async function characterLookaheadPage(
  bookId: string,
  issueId: string,
  pageNumber: number,
) {
  "use step";
  const { createTypedStepClient } = await import("../step-utils");
  const supabase = await createTypedStepClient();
  const deps: LookaheadDeps = {
    imageLib: sharp,
    faceExtraction: await import("~/lib/face-extraction"),
    characterIdentification: await import("~/lib/character-identification"),
    exemplarStore: await import("~/lib/exemplar-store"),
    llmUsage: await import("~/lib/llm-usage"),
    geminiClient: await import("~/lib/gemini-client"),
  };

  const page = await loadLookaheadPageOrFatal(
    deps,
    supabase,
    bookId,
    issueId,
    pageNumber,
    { skipIfStored: true },
  );
  const pageLabel = `page-${String(pageNumber).padStart(2, "0")}`;

  if ("skip" in page) {
    console.log(`[lookahead] ${pageLabel}: ${page.skip}, skip`);
    if (page.stored) {
      await groupUnnamedFacesOrFatal(supabase, bookId, issueId, pageLabel);
    }
    return;
  }

  const faces = await identifyLookaheadFacesOrFatal(
    deps,
    supabase,
    bookId,
    issueId,
    page,
  );
  const stored = await storeLookaheadFacesOrFatal(
    deps,
    supabase,
    bookId,
    issueId,
    page,
    faces,
  );
  const grouped = await groupUnnamedFacesOrFatal(
    supabase,
    bookId,
    issueId,
    pageLabel,
  );

  console.log(
    `[lookahead] ${bookId}/${issueId}: ${pageLabel} → ${faces.length} faces, ${stored.named} named, ${stored.unnamed} unnamed${grouped ? `; issue has ${grouped.faces} unnamed in ${grouped.groups} group(s), ${grouped.updated} regrouped` : ""}`,
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
  const { GEMINI_FAST } = await import("~/lib/models");
  const { generateContentLogged } = await import("~/lib/llm-usage");

  const padded = String(pageNumber).padStart(2, "0");
  const pageLabel = `page-${padded}`;
  const llmMeta = { step: "get-context", bookId, issueId, pageNumber };
  // The cue call's rows, apart from the OCR and speaker calls' (#437).
  const cueMeta = { ...llmMeta, step: "get-context:cues" };

  // Book and synopsis context for the prompt. The wiki's character names stay
  // out: the speaker comes from the closed cast below, never from an open
  // list (#354).
  let bookContext: string | undefined;
  const [
    { data: bookRow, error: bookErr },
    { data: issueRow, error: issueErr },
  ] = await Promise.all([
    supabase.from("books").select("name, franchises").eq("id", bookId).single(),
    selectIssue(supabase, bookId, issueId, "wiki_summary").single(),
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
    bookContext = parts.length > 0 ? parts.join("\n") : undefined;
  }

  // The closed cast (#354): the issue's castlist, each row joined to its
  // `characters` row for the id the bubble gets and the aliases the match
  // accepts. One `loadBookCast` read; `issueCast` is the rule `getCast` uses.
  // Both throws come before any download or Gemini call, so a bad cast
  // fails here and spends nothing.
  const { issueCast, loadBookCast } = await import("~/lib/cast");
  const bookCast = await loadBookCast(supabase, bookId);
  const castRows = issueCast(bookCast, issueId);
  const cast: ClosedCastMember[] = [];
  const unresolved: string[] = [];
  for (const entry of castRows) {
    const row = entry.character_id
      ? bookCast.resolve(entry.character_id)
      : undefined;
    if (!row) {
      // `bubbles.character_id` references `characters`, so a row with no
      // character could never be a match. Nothing is created for it.
      unresolved.push(entry.character);
      continue;
    }
    if (cast.some((m) => m.id === row.id)) continue;
    cast.push({
      id: row.id,
      name: row.display_name ?? entry.character,
      aliases: row.aliases,
    });
  }
  if (unresolved.length > 0) {
    throw new FatalError(
      `get-context: ${bookId}/${issueId} castlist row${unresolved.length === 1 ? "" : "s"} ${unresolved.map((c) => JSON.stringify(c)).join(", ")} match no characters row. Name ${unresolved.length === 1 ? "it" : "them"} under "Needs a name" at the characters stop (review-clusters) before running get-context.`,
    );
  }
  if (cast.length === 0) {
    throw new FatalError(
      `get-context: ${bookId}/${issueId} has no cast. The cast is seeded at the characters stop (review-clusters); confirm it there before running get-context.`,
    );
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

  // Every page, not only after the fallback insert: a retry after a failed
  // link write finds the bubbles present and still links them (#306).
  await linkBubblesToPanels(
    supabase,
    bookId,
    issueId,
    pageNumber,
    pageLabel,
    null,
  );

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

  // The cast members a face detection on this page named: marked "seen on
  // this page" in the list. A detection naming nobody on the cast adds
  // nothing; the list is the cast and only the cast.
  const seenIds = new Set<string>();
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

    for (const d of detections ?? []) {
      if (d.character_id != null) seenIds.add(d.character_id);
    }
  }
  const castLines = closedCastLines(cast, seenIds);

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

  let matched = 0;
  let unmatched = 0;

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
        "Extract all text from this comic book speech bubble. Return ONLY the text exactly as it appears. No explanation or formatting. Plain text only: bold, italic or larger lettering is written like any other word, with no asterisks, underscores or other markup around it.",
      );

      const ocrResponse = await generateContentLogged(
        gemini,
        { model: GEMINI_FAST, contents: [ocrImagePart, ocrPrompt] },
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

    // The speaker call carries no cue rules; the cue line is the second
    // call below (#437).
    const { buildContextPrompt } = await import("~/lib/gemini-prompts");
    const contextPrompt = buildContextPrompt(
      ocrText,
      box,
      castLines,
      bookContext,
      { closedList: true, castNotes: CLOSED_CAST_NOTES, noCues: true },
    );

    try {
      const {
        createPartFromBase64: cpb64,
        createPartFromText: cpt,
        ThinkingLevel,
      } = await import("@google/genai");
      const pageImagePart = cpb64(imgBuf.toString("base64"), "image/webp");
      const contextTextPart = cpt(contextPrompt);

      const contextResponse = await generateContentLogged(
        gemini,
        { model: GEMINI_FAST, contents: [pageImagePart, contextTextPart] },
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
      const { match, emotion } = resolveContext(parsed, cast);

      // The cue line: the bubble's text with the speaker and emotion the
      // update stores, sent as the editor's Regenerate cues sends it. A
      // failed or empty reply throws to the catch below, so the bubble gets
      // no update and a rerun picks it up; the OCR text is never the
      // fallback cue line.
      const { buildCuePrompt } = await import("~/lib/cue-rules");
      let cueLine: string;
      try {
        const cueResponse = await generateContentLogged(
          gemini,
          {
            model: GEMINI_FAST,
            contents: buildCuePrompt({
              text: ocrText,
              emotion,
              speaker: match?.id ?? null,
            }),
            config: { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } },
          },
          cueMeta,
        );
        cueLine = cueResponse.text?.trim() ?? "";
      } catch (e) {
        throw new Error(`cue call failed: ${errorText(e)}`);
      }
      if (!cueLine) throw new Error("cue call returned an empty reply");

      const update = buildContextUpdate(
        parsed,
        ocrText,
        aiReasoning,
        cast,
        cueLine,
      );

      if (update.character_id) {
        matched++;
      } else if (!update.ignored) {
        // Null speaker on a spoken bubble: the review editor flags it as
        // "needs you" and page approval waits on it. Nothing is guessed.
        unmatched++;
        const raw = contextSpeakerReply(parsed);
        console.warn(
          `[context] ${pageLabel} bubble ${bubble.legacy_id}: speaker ${raw === null ? "null" : JSON.stringify(raw)} is not in the cast, stored null for review`,
        );
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
    `[context] ${bookId}/${issueId}: ${pageLabel} → ${bubbles.length} bubbles processed, ${matched} speakers matched from a cast of ${cast.length}, ${unmatched} left for review`,
  );
}

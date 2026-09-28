import type { SupabaseClient } from "@supabase/supabase-js";
import sharp from "sharp";
import { FatalError } from "workflow";
import { GEMINI_MEDIUM } from "~/lib/models";
import { pageImageUrl, pageStoragePath } from "~/lib/storage";
import type { Database, Json } from "~/types/database";
import type { PageMeta, BoundingBoxJson } from "./shared";
import { rdpSimplify } from "./shared";
import {
  bubbleHasContext,
  buildContextUpdate,
  mapBubbleRows,
  mapPanelRows,
  mapSegmentationRow,
  parseRoboflowSam3Output,
  type ContextParsed,
  type RoboflowBoxPrediction,
  type RoboflowSam3Output,
} from "./vision-rows";
import { selectIssue } from "~/lib/issue-queries";

type TypedClient = SupabaseClient<Database>;

export {
  bubbleHasContext,
  buildContextUpdate,
  mapBubbleRows,
  mapPanelRows,
  mapSegmentationRow,
  parseRoboflowSam3Output,
} from "./vision-rows";

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
  const apiKey = process.env.ROBOFLOW_API_KEY;
  if (!apiKey) {
    throw new FatalError("ROBOFLOW_API_KEY required");
  }

  const failedPageLabels: string[] = [];

  for (const page of pages) {
    const padded = String(page.pageNumber).padStart(2, "0");
    const pageLabel = `page-${padded}`;

    const { count: panelCount, error: panelCountErr } = await supabase
      .from("panels")
      .select("*", { count: "exact", head: true })
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

    const existingPanels = panelCount ?? 0;
    const existingSeg = segCount ?? 0;
    const existingBubbles = bubbleCount ?? 0;

    if (existingPanels > 0 && existingSeg > 0) {
      console.log(
        `[roboflow] ${pageLabel}: panels and page_segmentation already present, skip Roboflow call`,
      );
      continue;
    }

    const imageUrl = pageImageUrl(bookId, issueId, page.pageNumber);

    let res: Response;
    try {
      res = await fetch(workflowUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          inputs: { image: { type: "url", value: imageUrl } },
        }),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[roboflow] ${pageLabel}: fetch failed: ${msg.slice(0, 160)}`,
      );
      failedPageLabels.push(pageLabel);
      continue;
    }

    if (!res.ok) {
      const text = await res.text();
      console.warn(
        `[roboflow] ${pageLabel}: SAM3 workflow ${res.status}: ${text.slice(0, 160)}`,
      );
      failedPageLabels.push(pageLabel);
      continue;
    }

    let data: { outputs?: unknown[] };
    try {
      data = (await res.json()) as { outputs?: unknown[] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[roboflow] ${pageLabel}: non-JSON response: ${msg.slice(0, 160)}`,
      );
      failedPageLabels.push(pageLabel);
      continue;
    }

    const parsed = parseRoboflowSam3Output(
      data.outputs?.[0] as RoboflowSam3Output | undefined,
    );
    if (!parsed) {
      console.warn(
        `[roboflow] ${pageLabel}: missing or malformed predictions in response`,
      );
      failedPageLabels.push(pageLabel);
      continue;
    }

    const {
      panelPredictions,
      image: imgDims,
      bubblePredictions,
      segmentationPredictions: segPreds,
    } = parsed;
    const panelRows = mapPanelRows(
      bookId,
      issueId,
      page.pageNumber,
      panelPredictions,
      imgDims,
    );
    const bubbleRows = mapBubbleRows(
      bookId,
      issueId,
      page.pageNumber,
      bubblePredictions,
    );

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

    console.log(
      `[roboflow] ${bookId}/${issueId}: ${pageLabel} → ${panelRows.length} panels, ${bubbleRows.length} bubbles, ${segPreds.length} segments`,
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

  const CHARACTER_CLASSES = new Set([
    "comic character",
    "person",
    "face",
    "head",
  ]);
  const BUBBLE_CLASSES = new Set(["speech bubble"]);
  const MAX_VERTS = 50;

  type PolyPoint = { x: number; y: number };

  function simplifyPoly(points: PolyPoint[]): PolyPoint[] {
    if (points.length <= MAX_VERTS) return points;
    let simplified = points;
    let eps = 0.005;
    while (simplified.length > MAX_VERTS && eps < 0.1) {
      simplified = rdpSimplify(points, eps);
      eps *= 1.5;
    }
    return simplified;
  }

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
    const predictions = segRow.predictions as Array<{
      class: string;
      confidence: number;
      points: Array<{ x: number; y: number }>;
    }>;

    type PanelPx = { id: string; x: number; y: number; w: number; h: number };
    const panelsPx: PanelPx[] = panels.map((p) => {
      const bb = p.bounding_box as BoundingBoxJson;
      return {
        id: p.id,
        x: bb.x * imgW,
        y: bb.y * imgH,
        w: bb.w * imgW,
        h: bb.h * imgH,
      };
    });

    const panelCharPolys = new Map<string, PolyPoint[][]>();
    const panelBubblePolys = new Map<string, PolyPoint[][]>();
    for (const p of panelsPx) {
      panelCharPolys.set(p.id, []);
      panelBubblePolys.set(p.id, []);
    }

    for (const pred of predictions) {
      const isChar = CHARACTER_CLASSES.has(pred.class);
      const isBubble = BUBBLE_CLASSES.has(pred.class);
      if (!isChar && !isBubble) continue;
      if (pred.points.length < 3) continue;

      let cx = 0;
      let cy = 0;
      for (const pt of pred.points) {
        cx += pt.x;
        cy += pt.y;
      }
      cx /= pred.points.length;
      cy /= pred.points.length;

      for (const panel of panelsPx) {
        if (
          cx >= panel.x &&
          cx <= panel.x + panel.w &&
          cy >= panel.y &&
          cy <= panel.y + panel.h
        ) {
          const localPoly = pred.points.map((pt) => ({
            x: (pt.x - panel.x) / panel.w,
            y: (pt.y - panel.y) / panel.h,
          }));

          const simplified = simplifyPoly(localPoly);
          const target = isChar
            ? panelCharPolys.get(panel.id)!
            : panelBubblePolys.get(panel.id)!;
          target.push(simplified);
          break;
        }
      }
    }

    for (const p of panelsPx) {
      const characters = panelCharPolys.get(p.id)!;
      const bubbles = panelBubblePolys.get(p.id)!;
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

    const totalChars = [...panelCharPolys.values()].reduce(
      (s, a) => s + a.length,
      0,
    );
    const totalBubbles = [...panelBubblePolys.values()].reduce(
      (s, a) => s + a.length,
      0,
    );
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
  const { findSimilarExemplars, downloadExemplarImage, storeExemplar } =
    await import("~/lib/exemplar-store");

  const gemini = getGeminiClient();
  const padded = String(pageNumber).padStart(2, "0");
  const pageLabel = `page-${padded}`;

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

  // 2. Download page image from Storage
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

  // 3. Load panels from DB
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
    let exemplarRefs: Array<{
      characterName: string;
      jpegBase64: string;
      confidence: number;
    }> = [];
    try {
      const matches = await findSimilarExemplars(
        supabase,
        face.jpegBuffer.toString("base64"),
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
      exemplarRefs = refs.filter((r): r is NonNullable<typeof r> => r !== null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new FatalError(
        `character_face_exemplars failed for ${pageLabel}: ${msg}`,
      );
    }

    // Identify with exemplar context + key failover
    let result;
    try {
      result = await identifyFace(
        gemini,
        face.jpegBuffer.toString("base64"),
        "image/jpeg",
        knownCharacters,
        exemplarRefs,
        pageBase64,
        "image/webp",
        wikiSummary,
      );
    } catch (err: unknown) {
      const status =
        err && typeof err === "object" && "status" in err
          ? (err as { status: number }).status
          : 0;
      if (status === 429) {
        const fallback = getFallbackGeminiClient();
        if (fallback) {
          try {
            result = await identifyFace(
              fallback,
              face.jpegBuffer.toString("base64"),
              "image/jpeg",
              knownCharacters,
              exemplarRefs,
              pageBase64,
              "image/webp",
              wikiSummary,
            );
          } catch {
            continue;
          }
        } else {
          continue;
        }
      } else {
        continue;
      }
    }

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
        try {
          await storeExemplar(supabase, {
            jpegBuffer: face.jpegBuffer,
            characterId: charId,
            suggestedName: charId ? undefined : result.characterName,
            bookId,
            sourceIssue: issueId,
            pageNumber,
            confidence: result.confidence,
            isConfirmed: charId !== null && result.confidence >= 0.9,
          });
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
  const gemini = getGemini();
  const { GEMINI_HIGH } = await import("~/lib/models");

  const padded = String(pageNumber).padStart(2, "0");
  const pageLabel = `page-${padded}`;

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
    const rfRes = await fetch(roboflowUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: roboflowKey,
        inputs: { image: { type: "base64", value: base64Image } },
      }),
    });

    if (!rfRes.ok) {
      console.warn(`[context] ${pageLabel}: Roboflow text detection failed`);
      return;
    }

    const rfData = (await rfRes.json()) as {
      outputs?: Array<{
        predictions?: {
          predictions: RoboflowBoxPrediction[];
        };
      }>;
    };

    const preds = rfData.outputs?.[0]?.predictions?.predictions ?? [];
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

      const ocrResponse = await gemini.models.generateContent({
        model: GEMINI_MEDIUM,
        contents: [ocrImagePart, ocrPrompt],
      });

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

      const contextResponse = await gemini.models.generateContent({
        model: GEMINI_HIGH,
        contents: [pageImagePart, contextTextPart],
      });

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

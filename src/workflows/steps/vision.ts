import sharp from "sharp";
import { GEMINI_MEDIUM } from "~/lib/models";
import type { PageMeta, BoundingBoxJson } from "./shared";
import { rdpSimplify } from "./shared";

export async function roboflowAnalyzeBatch(
  bookId: string,
  issueId: string,
  pages: PageMeta[],
) {
  "use step";
  const { createStepClient } = await import("../step-utils");
  const supabase = await createStepClient();

  const workflowUrl = process.env.ROBOFLOW_SAM3_WORKFLOW_URL;
  const apiKey = process.env.ROBOFLOW_API_KEY;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!workflowUrl || !apiKey || !supabaseUrl) {
    throw new Error(
      "ROBOFLOW_SAM3_WORKFLOW_URL, ROBOFLOW_API_KEY, and NEXT_PUBLIC_SUPABASE_URL required",
    );
  }

  for (const page of pages) {
    const padded = String(page.pageNumber).padStart(2, "0");
    const imageUrl = `${supabaseUrl}/storage/v1/object/public/comic-pages/${bookId}/${issueId}/page-${padded}.webp`;

    const res = await fetch(workflowUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        inputs: { image: { type: "url", value: imageUrl } },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.warn(
        `[roboflow] page-${padded}: SAM3 workflow ${res.status}: ${text.slice(0, 160)}`,
      );
      continue;
    }

    const data = (await res.json()) as {
      outputs?: Array<{
        panel_predictions?: {
          image: { width: number; height: number };
          predictions: Array<{
            x: number;
            y: number;
            width: number;
            height: number;
            confidence: number;
            class: string;
            detection_id: string;
          }>;
        };
        bubble_predictions?: {
          predictions: Array<{
            x: number;
            y: number;
            width: number;
            height: number;
            confidence: number;
            class: string;
            detection_id: string;
          }>;
        };
        segmentation_predictions?: {
          predictions: Array<{
            class: string;
            confidence: number;
            detection_id: string;
            parent_id: string;
            points: Array<{ x: number; y: number }>;
          }>;
        };
      }>;
    };

    const out = data.outputs?.[0];
    if (!out?.panel_predictions) {
      console.warn(`[roboflow] page-${padded}: no panel predictions returned`);
      continue;
    }

    const imgDims = out.panel_predictions.image;

    const panelRows = out.panel_predictions.predictions.map((p, idx) => ({
      book_id: bookId,
      issue_id: issueId,
      page_number: page.pageNumber,
      panel_id: `p${padded}-${idx + 1}`,
      sort_order: idx,
      bounding_box: {
        x: (p.x - p.width / 2) / imgDims.width,
        y: (p.y - p.height / 2) / imgDims.height,
        w: p.width / imgDims.width,
        h: p.height / imgDims.height,
      },
      confidence: p.confidence,
    }));

    if (panelRows.length > 0) {
      const { error: pErr } = await supabase.from("panels").upsert(panelRows, {
        onConflict: "book_id,issue_id,page_number,panel_id",
      });
      if (pErr)
        console.warn(
          `[roboflow] page-${padded} panels upsert: ${pErr.message}`,
        );
    }

    const bubblePreds = out.bubble_predictions?.predictions ?? [];
    const bubbleRows = bubblePreds.map((b, idx) => ({
      book_id: bookId,
      issue_id: issueId,
      page_number: page.pageNumber,
      legacy_id: `page-${padded}_b${String(idx + 1).padStart(2, "0")}`,
      box_2d: {
        x: Math.round(b.x - b.width / 2),
        y: Math.round(b.y - b.height / 2),
        width: Math.round(b.width),
        height: Math.round(b.height),
      },
      confidence: b.confidence,
    }));

    if (bubbleRows.length > 0) {
      const { error: bErr } = await supabase
        .from("bubbles")
        .upsert(bubbleRows, {
          onConflict: "book_id,issue_id,page_number,legacy_id",
        });
      if (bErr)
        console.warn(
          `[roboflow] page-${padded} bubbles upsert: ${bErr.message}`,
        );
    }

    const segPreds = out.segmentation_predictions?.predictions ?? [];
    if (segPreds.length > 0) {
      const { error: sErr } = await supabase.from("page_segmentation").upsert(
        {
          book_id: bookId,
          issue_id: issueId,
          page_number: page.pageNumber,
          image_width: imgDims.width,
          image_height: imgDims.height,
          predictions: segPreds,
        },
        { onConflict: "book_id,issue_id,page_number" },
      );
      if (sErr)
        console.warn(
          `[roboflow] page-${padded} segmentation upsert: ${sErr.message}`,
        );
    }

    console.log(
      `[roboflow] ${bookId}/${issueId}: page-${padded} → ${panelRows.length} panels, ${bubbleRows.length} bubbles, ${segPreds.length} segments`,
    );

    await new Promise((r) => setTimeout(r, 750));
  }
}

export async function extractForegroundMasksBatch(
  bookId: string,
  issueId: string,
  pages: PageMeta[],
) {
  "use step";
  const { createStepClient } = await import("../step-utils");
  const supabase = await createStepClient();

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

    const { data: segRow } = await supabase
      .from("page_segmentation")
      .select("image_width, image_height, predictions")
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .eq("page_number", page.pageNumber)
      .single();

    if (!segRow) {
      console.log(`[masks] page-${padded}: no segmentation data — skip`);
      continue;
    }

    const { data: panels } = await supabase
      .from("panels")
      .select("id, bounding_box")
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .eq("page_number", page.pageNumber)
      .order("sort_order");

    if (!panels || panels.length === 0) {
      console.log(`[masks] page-${padded}: no panels — skip`);
      continue;
    }

    const imgW = segRow.image_width as number;
    const imgH = segRow.image_height as number;
    const predictions = segRow.predictions as Array<{
      class: string;
      confidence: number;
      points: Array<{ x: number; y: number }>;
    }>;

    type PanelPx = { id: string; x: number; y: number; w: number; h: number };
    const panelsPx: PanelPx[] = panels.map((p) => {
      const bb = p.bounding_box as BoundingBoxJson;
      return {
        id: p.id as string,
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
      await supabase
        .from("panels")
        .update({ foreground_polygons: { characters, bubbles } })
        .eq("id", p.id);
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
  const { createStepClient } = await import("../step-utils");
  const supabase = await createStepClient();

  const { getGeminiClient, getFallbackGeminiClient } = await import(
    "~/lib/gemini-client"
  );
  const { extractFaceCropsFromBuffer } = await import("~/lib/face-extraction");
  const { identifyFace, resolveCharacterId, buildKnownCharacterList } =
    await import("~/lib/character-identification");
  const { findSimilarExemplars, downloadExemplarImage, storeExemplar } =
    await import("~/lib/exemplar-store");

  const gemini = getGeminiClient();
  const padded = String(pageNumber).padStart(2, "0");

  // 1. Load segmentation predictions from DB
  const { data: segRow } = await supabase
    .from("page_segmentation")
    .select("image_width, image_height, predictions")
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("page_number", pageNumber)
    .single();

  if (!segRow) {
    console.log(`[lookahead] page-${padded}: no segmentation — skip`);
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
    console.log(`[lookahead] page-${padded}: no faces detected — skip`);
    return;
  }

  // 2. Download page image from Storage
  const storagePath = `${bookId}/${issueId}/pages/page-${padded}.webp`;
  const { data: imageBlob } = await supabase.storage
    .from("comic-pages")
    .download(storagePath);

  if (!imageBlob) {
    console.log(`[lookahead] page-${padded}: image not found — skip`);
    return;
  }

  const imgBuf = Buffer.from(await imageBlob.arrayBuffer());
  const meta = await sharp(imgBuf).metadata();
  const imgW = meta.width ?? 0;
  const imgH = meta.height ?? 0;
  if (imgW === 0 || imgH === 0) return;

  // 3. Load panels from DB
  const { data: panels } = await supabase
    .from("panels")
    .select("id, bounding_box, sort_order")
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("page_number", pageNumber)
    .order("sort_order");

  if (!panels || panels.length === 0) return;

  const panelRects = panels.map((p) => {
    const bb = p.bounding_box as BoundingBoxJson;
    return {
      id: p.id as string,
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
    console.log(`[lookahead] page-${padded}: no valid face crops — skip`);
    return;
  }

  // 5. Build known character list
  const knownCharacters = await buildKnownCharacterList(supabase, bookId);

  // 6. Identify each face with exemplar context
  const detectionRows: Array<{
    character_id: string | null;
    suggested_name?: string;
    panel_id: string;
    face_bbox: object;
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
    } catch {
      // Exemplar lookup failed — proceed without
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
      const charId = await resolveCharacterId(supabase, result.characterName);

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
        } catch {
          // Non-fatal — exemplar storage failure shouldn't stop identification
        }
      }
    }

    // Rate limit delay between faces
    await new Promise((r) => setTimeout(r, 800));
  }

  if (detectionRows.length > 0) {
    const panelIdsInBatch = [...new Set(detectionRows.map((r) => r.panel_id))];
    const { data: existingDets } = await supabase
      .from("panel_character_detections")
      .select("character_id, suggested_name, panel_id")
      .in("panel_id", panelIdsInBatch);

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
        console.warn(
          `[lookahead] page-${padded}: insert failed: ${error.message}`,
        );
      }
    }
  }

  console.log(
    `[lookahead] ${bookId}/${issueId}: page-${padded} → ${faceCrops.length} faces, ${detectionRows.length} identified`,
  );
}

export async function getContextPage(
  bookId: string,
  issueId: string,
  pageNumber: number,
) {
  "use step";
  const { createStepClient } = await import("../step-utils");
  const supabase = await createStepClient();

  const geminiKey = process.env.GEMINI_API_KEY;
  const roboflowKey = process.env.ROBOFLOW_API_KEY;
  const roboflowUrl = process.env.ROBOFLOW_WORKFLOW_URL;
  if (!geminiKey || !roboflowKey || !roboflowUrl) {
    throw new Error(
      "GEMINI_API_KEY, ROBOFLOW_API_KEY, and ROBOFLOW_WORKFLOW_URL required",
    );
  }

  const { getGeminiClient: getGemini } = await import("~/lib/gemini-client");
  const gemini = getGemini();
  const { GEMINI_HIGH } = await import("~/lib/models");

  const padded = String(pageNumber).padStart(2, "0");

  // Load book + wiki context for richer prompts
  let bookContext: string | undefined;
  const [{ data: bookRow }, { data: issueRow }] = await Promise.all([
    supabase.from("books").select("name, franchises").eq("id", bookId).single(),
    supabase
      .from("issues")
      .select("wiki_summary, wiki_appearances")
      .eq("book_id", bookId)
      .eq("id", issueId)
      .single(),
  ]);
  {
    const parts: string[] = [];
    if (bookRow) {
      const bookName = bookRow.name as string;
      const franchises = bookRow.franchises as string[] | null;
      if (bookName) parts.push(`Book: ${bookName}`);
      if (franchises?.length)
        parts.push(`Franchises: ${franchises.join(", ")}`);
    }
    if (issueRow?.wiki_summary) {
      parts.push(`\nIssue Synopsis:\n${issueRow.wiki_summary as string}`);
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

  const storagePath = `${bookId}/${issueId}/pages/page-${padded}.webp`;
  const { data: imageBlob } = await supabase.storage
    .from("comic-pages")
    .download(storagePath);

  if (!imageBlob) {
    console.warn(`[context] page-${padded}: image not found — skip`);
    return;
  }

  const imgBuf = Buffer.from(await imageBlob.arrayBuffer());

  const { data: initialBubbles } = await supabase
    .from("bubbles")
    .select("id, legacy_id, box_2d, ocr_text")
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("page_number", pageNumber);

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
      console.warn(`[context] page-${padded}: Roboflow text detection failed`);
      return;
    }

    const rfData = (await rfRes.json()) as {
      outputs?: Array<{
        predictions?: {
          predictions: Array<{
            x: number;
            y: number;
            width: number;
            height: number;
            confidence: number;
          }>;
        };
      }>;
    };

    const preds = rfData.outputs?.[0]?.predictions?.predictions ?? [];
    if (preds.length === 0) {
      console.log(`[context] page-${padded}: no text regions found`);
      return;
    }

    const newBubbles = preds.map((p, idx) => ({
      book_id: bookId,
      issue_id: issueId,
      page_number: pageNumber,
      legacy_id: `page-${padded}_b${String(idx + 1).padStart(2, "0")}`,
      box_2d: {
        x: Math.round(p.x - p.width / 2),
        y: Math.round(p.y - p.height / 2),
        width: Math.round(p.width),
        height: Math.round(p.height),
      },
      confidence: p.confidence,
    }));

    await supabase.from("bubbles").upsert(newBubbles, {
      onConflict: "book_id,issue_id,page_number,legacy_id",
    });

    const { data: requeried } = await supabase
      .from("bubbles")
      .select("id, legacy_id, box_2d, ocr_text")
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .eq("page_number", pageNumber);

    if (!requeried || requeried.length === 0) return;
    bubbleData = requeried;
  }

  const { data: pagePanels } = await supabase
    .from("panels")
    .select("id, page_number")
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("page_number", pageNumber);

  const pageCharNames: string[] = [];
  if (pagePanels && pagePanels.length > 0) {
    const panelIds = pagePanels.map((p) => p.id as string);
    const { data: detections } = await supabase
      .from("panel_character_detections")
      .select("character_id")
      .in("panel_id", panelIds);

    if (detections) {
      for (const d of detections) {
        const name = (d.character_id as string).replace(/-/g, " ");
        if (!pageCharNames.includes(name)) pageCharNames.push(name);
      }
    }
  }

  type BubbleRow = {
    id: string;
    legacy_id: string;
    box_2d: { x: number; y: number; width: number; height: number };
    ocr_text: string | null;
  };

  const bubbles = bubbleData as BubbleRow[];
  const uniqueSpeakers: string[] = [];

  for (const bubble of bubbles) {
    if (bubble.ocr_text) continue;

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
        `[context] page-${padded} bubble ${bubble.legacy_id}: OCR failed`,
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

      const parsed = JSON.parse(jsonMatch[0]) as {
        type?: string;
        speaker?: string | null;
        emotion?: string;
        characterType?: string;
        side?: string;
        voiceDescription?: string;
        textWithCues?: string;
      };

      const bubbleType = parsed.type ?? "SPEECH";
      const speaker =
        bubbleType === "NARRATION" || bubbleType === "CAPTION"
          ? "Narrator"
          : (parsed.speaker ?? null);

      if (speaker && !uniqueSpeakers.includes(speaker)) {
        uniqueSpeakers.push(speaker);
      }

      await supabase
        .from("bubbles")
        .update({
          ocr_text: ocrText,
          text: parsed.textWithCues ?? ocrText,
          type: bubbleType,
          speaker,
          emotion: parsed.emotion ?? "neutral",
          character_type: parsed.characterType ?? null,
          side: parsed.side ?? null,
          voice_description: parsed.voiceDescription ?? null,
          text_with_cues: parsed.textWithCues ?? ocrText,
          ai_reasoning: aiReasoning,
          ignored: bubbleType === "SFX" || bubbleType === "BACKGROUND",
        })
        .eq("id", bubble.id);
    } catch (e) {
      console.warn(
        `[context] page-${padded} bubble ${bubble.legacy_id}: context analysis failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log(
    `[context] ${bookId}/${issueId}: page-${padded} → ${bubbles.length} bubbles processed, ${uniqueSpeakers.length} speakers found`,
  );
}

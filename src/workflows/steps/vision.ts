import {
  GoogleGenAI,
  createPartFromBase64,
  createPartFromText,
} from "@google/genai";
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
    const imageUrl = `${supabaseUrl}/storage/v1/object/public/comic-pages/${bookId}/${issueId}/pages/page-${padded}.webp`;

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

  const FOREGROUND_CLASSES = new Set([
    "comic character",
    "person",
    "face",
    "head",
  ]);
  const MAX_VERTS = 50;

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

    const panelPolygons = new Map<
      string,
      Array<Array<{ x: number; y: number }>>
    >();
    for (const p of panelsPx) panelPolygons.set(p.id, []);

    for (const pred of predictions) {
      if (!FOREGROUND_CLASSES.has(pred.class)) continue;
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

          let simplified = localPoly;
          if (simplified.length > MAX_VERTS) {
            let eps = 0.005;
            while (simplified.length > MAX_VERTS && eps < 0.1) {
              simplified = rdpSimplify(localPoly, eps);
              eps *= 1.5;
            }
          }

          panelPolygons.get(panel.id)!.push(simplified);
          break;
        }
      }
    }

    for (const [panelId, polygons] of panelPolygons) {
      if (polygons.length === 0) continue;
      await supabase
        .from("panels")
        .update({ foreground_polygons: polygons })
        .eq("id", panelId);
    }

    const totalPolys = [...panelPolygons.values()].reduce(
      (s, a) => s + a.length,
      0,
    );
    console.log(
      `[masks] ${bookId}/${issueId}: page-${padded} → ${totalPolys} foreground polygon(s) across ${panels.length} panel(s)`,
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

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");
  const gemini = new GoogleGenAI({ apiKey });

  const padded = String(pageNumber).padStart(2, "0");

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

  const FACE_CLASSES = new Set(["face", "head"]);
  const facePreds = predictions.filter(
    (p) => FACE_CLASSES.has(p.class) && p.points.length >= 3,
  );

  if (facePreds.length === 0) {
    console.log(`[lookahead] page-${padded}: no faces detected — skip`);
    return;
  }

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

  const { data: panels } = await supabase
    .from("panels")
    .select("id, bounding_box, sort_order")
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("page_number", pageNumber)
    .order("sort_order");

  if (!panels || panels.length === 0) return;

  const panelsPx = panels.map((p) => {
    const bb = p.bounding_box as BoundingBoxJson;
    return {
      id: p.id as string,
      x: bb.x * imgW,
      y: bb.y * imgH,
      w: bb.w * imgW,
      h: bb.h * imgH,
    };
  });

  const { data: chars } = await supabase
    .from("characters")
    .select("id, aliases")
    .eq("book_id", bookId);

  const knownNames: string[] = [];
  for (const c of chars ?? []) {
    const id = c.id as string;
    knownNames.push(id.replace(/-/g, " "));
    const aliases = c.aliases as string[] | null;
    if (aliases) knownNames.push(...aliases);
  }

  const detectionRows: Array<{
    character_id: string;
    panel_id: string;
    face_bbox: object;
    identification_confidence: number;
  }> = [];

  for (const facePred of facePreds) {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const pt of facePred.points) {
      if (pt.x < minX) minX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y > maxY) maxY = pt.y;
    }

    const faceW = maxX - minX;
    const faceH = maxY - minY;
    if (faceW < 30 || faceH < 30) continue;

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const panel = panelsPx.find(
      (p) => cx >= p.x && cx <= p.x + p.w && cy >= p.y && cy <= p.y + p.h,
    );
    if (!panel) continue;

    const pad = 0.2;
    const cropX = Math.max(0, Math.round(minX - faceW * pad));
    const cropY = Math.max(0, Math.round(minY - faceH * pad));
    const cropW = Math.min(imgW - cropX, Math.round(faceW * (1 + 2 * pad)));
    const cropH = Math.min(imgH - cropY, Math.round(faceH * (1 + 2 * pad)));

    let faceBuf: Buffer;
    try {
      faceBuf = await sharp(imgBuf)
        .extract({ left: cropX, top: cropY, width: cropW, height: cropH })
        .toBuffer();
    } catch {
      continue;
    }

    const identifyPrompt = `You are identifying a comic book character from a face crop.
${knownNames.length > 0 ? `Known characters: ${knownNames.join(", ")}` : "No character list available."}

Based on visual features (skin color, mask, helmet, hair, costume, species), identify who this character is.
Only provide a name if you are genuinely confident.

Output JSON only (no markdown fences):
{"character_name": "Name" or null, "confidence": 0.0-1.0}`;

    try {
      const imagePart = createPartFromBase64(
        faceBuf.toString("base64"),
        "image/webp",
      );
      const textPart = createPartFromText(identifyPrompt);

      const response = await gemini.models.generateContent({
        model: GEMINI_MEDIUM,
        contents: [imagePart, textPart],
      });

      const text = response.text?.trim() ?? "";
      const cleaned = text
        .replace(/^```json\s*/i, "")
        .replace(/```\s*$/, "")
        .trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (!jsonMatch) continue;

      const parsed = JSON.parse(jsonMatch[0]) as {
        character_name: string | null;
        confidence: number;
      };

      if (parsed.character_name && parsed.confidence >= 0.6) {
        const charId = parsed.character_name
          .toLowerCase()
          .trim()
          .replace(/\s+/g, "-");

        await supabase
          .from("characters")
          .upsert(
            { id: charId, aliases: [parsed.character_name] },
            { onConflict: "id", ignoreDuplicates: true },
          );

        detectionRows.push({
          character_id: charId,
          panel_id: panel.id,
          face_bbox: {
            x: (minX - panel.x) / panel.w,
            y: (minY - panel.y) / panel.h,
            w: faceW / panel.w,
            h: faceH / panel.h,
          },
          identification_confidence: parsed.confidence,
        });
      }
    } catch {
      // Gemini call failed for this face — skip
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  if (detectionRows.length > 0) {
    const { error } = await supabase
      .from("panel_character_detections")
      .insert(detectionRows);
    if (error) {
      console.warn(
        `[lookahead] page-${padded}: insert failed: ${error.message}`,
      );
    }
  }

  console.log(
    `[lookahead] ${bookId}/${issueId}: page-${padded} → ${facePreds.length} faces, ${detectionRows.length} identified`,
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

  const { GoogleGenAI: GenAI } = await import("@google/genai");
  const gemini = new GenAI({ apiKey: geminiKey });
  const { GEMINI_HIGH } = await import("~/lib/models");

  const padded = String(pageNumber).padStart(2, "0");

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
    if (!box || !box.width || !box.height) continue;

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

    const charListStr =
      pageCharNames.length > 0
        ? `Characters detected on this page: ${pageCharNames.join(", ")}`
        : "";
    const speakerListStr =
      uniqueSpeakers.length > 0
        ? `Characters already identified: ${uniqueSpeakers.join(", ")}`
        : "";

    const contextPrompt = `I am providing a full comic book page.
**Goal:** Analyze the specific text region to determine how it should be voice-acted.
${charListStr}
${speakerListStr}

**Target Region:**
* **Text:** "${ocrText}"
* **Location:** x:${box.x}, y:${box.y} (width:${box.width}, height:${box.height})

**Instructions:**
1. Classify as: SPEECH, NARRATION, CAPTION, SFX, or BACKGROUND
2. If SPEECH, identify the speaker by tracing the bubble tail
3. Determine emotion and character type

Output JSON only (no markdown):
{"type":"SPEECH","speaker":"Name","emotion":"neutral","characterType":"MAJOR","side":"HERO","voiceDescription":"brief voice description","textWithCues":"text with <cue> tags for emphasis"}`;

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
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
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
          type: bubbleType,
          speaker,
          emotion: parsed.emotion ?? "neutral",
          character_type: parsed.characterType ?? null,
          side: parsed.side ?? null,
          voice_description: parsed.voiceDescription ?? null,
          text_with_cues: parsed.textWithCues ?? ocrText,
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

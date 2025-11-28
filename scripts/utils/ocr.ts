import {
  type GoogleGenAI,
  createPartFromBase64,
  createPartFromText,
} from "@google/genai";
import { join, dirname } from "path";
import fs from "fs-extra";
import { createOCRViewer, type OCRPrediction } from "./ocr-viewer.js";
import { type RoboflowPrediction } from "./roboflow.js";
import { cropImage } from "./image-crop.js";
import { boxesOverlap, type Box2D } from "./box-math.js";

export async function runOCR(
  predictions: RoboflowPrediction[],
  gemini: GoogleGenAI,
  imageBuffer: Buffer,
  options: {
    pageName: string;
    outDir: string;
  },
) {
  console.log(`\n📝 Running OCR on ${predictions.length} regions...`);
  await fs.ensureDir(join(options.outDir, options.pageName));

  const withOCR: OCRPrediction[] = await Promise.all(
    predictions.map(async (pred, index) => {
      // Save cropped image for debugging
      const cropFilename = `${options.pageName}-crop-${String(index + 1).padStart(3, "0")}-x${Math.floor(pred.x)}-y${Math.floor(pred.y)}.jpg`;
      const cropPath = join(options.outDir, options.pageName, cropFilename);
      const ocr_text = await runOCRGemini(gemini, imageBuffer, pred, cropPath);
      return { index, ...pred, ocr_text, cropPath };
    }),
  );
  console.log(`   ✓ OCR complete`);
  console.log(
    `   💾 Saved ${predictions.length} cropped images to: ${join(options.outDir, options.pageName)}`,
  );

  // Create HTML viewer for OCR results
  const viewerPath = await createOCRViewer(
    options.pageName,
    withOCR,
    options.outDir,
  );
  console.log(`   💾 Created OCR viewer: ${viewerPath}`);

  const validOCR = withOCR.filter(({ ocr_text }) => isValidText(ocr_text));
  const deduplicatedOCR = deduplicateOCRPredictionsByText(validOCR);
  const numInvalidOCRPredictions = withOCR.length - deduplicatedOCR.length;
  const numDeduplicatedOCRPredictions =
    validOCR.length - deduplicatedOCR.length;
  const totalOCRTextCount = deduplicatedOCR.reduce(
    (sum, { ocr_text }) => sum + ocr_text.length,
    0,
  );
  const estMinutesNeeded = totalOCRTextCount / 1000;

  await saveOCRPredictions(deduplicatedOCR, options.pageName, options.outDir, {
    invalidOCRTextCount: numInvalidOCRPredictions,
    deduplicatedOCRTextCount: numDeduplicatedOCRPredictions,
    totalOCRTextCount,
    estMinutesNeeded,
  });

  return deduplicatedOCR;
}

/**
 * Run OCR using Gemini Vision API
 */
async function runOCRGemini(
  gemini: GoogleGenAI,
  imageBuffer: Buffer,
  box: Box2D,
  savePath?: string,
): Promise<string> {
  // Extract the cropped region (minimal preprocessing for Gemini)
  const cropped = await cropImage(imageBuffer, box);

  // Save cropped image if path provided
  if (savePath) {
    await fs.ensureDir(dirname(savePath));
    await fs.writeFile(savePath, cropped);
  }

  // Use Gemini to extract text
  const base64Image = cropped.toString("base64");
  const imagePart = createPartFromBase64(base64Image, "image/jpeg");
  const prompt = createPartFromText(
    "Extract all text from this comic book speech bubble. Return ONLY the text exactly as it appears, preserving line breaks and punctuation. Do not add any explanation or formatting.",
  );

  try {
    const response = await gemini.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [imagePart, prompt],
    });

    const text = response.text;
    if (!text) {
      return "";
    }

    // Clean up the text
    return text
      .trim()
      .replace(/\s+/g, " ") // Normalize whitespace
      .replace(/\n\s*\n/g, "\n") // Remove empty lines
      .trim();
  } catch (error) {
    console.error(`    ⚠️  Gemini OCR error: ${error}`);
    return "";
  }
}

/**
 * Filter out empty or invalid text
 */
function isValidText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length === 1 && !["I", "A"].includes(trimmed)) return false;
  return true;
}

/**
 * Check if two text strings are similar (one is substring of the other or very similar)
 */
function textsAreSimilar(text1: string, text2: string): boolean {
  const normalize = (s: string) => s.trim().toUpperCase().replace(/[^\w]/g, "");
  const n1 = normalize(text1);
  const n2 = normalize(text2);

  if (n1 === n2) return true;
  if (n1.length > 0 && n2.length > 0) {
    return n1.includes(n2) || n2.includes(n1);
  }
  return false;
}

/**
 * Text deduplication: remove overlapping boxes with similar text
 */
function deduplicateOCRPredictionsByText(
  predictions: OCRPrediction[],
): OCRPrediction[] {
  console.log(`\n🔧 Deduplicating OCR predictions by text...`);
  const unique: OCRPrediction[] = [];

  for (const pred of predictions) {
    const duplicate = unique.find((p) => {
      const { ocr_text: existingOcrText, ...existingBox } = p;
      const doOverlap = boxesOverlap(pred, existingBox);
      const areTextsSimilar = textsAreSimilar(pred.ocr_text, existingOcrText);
      return doOverlap && areTextsSimilar;
    });

    if (!duplicate) {
      unique.push(pred);
    } else {
      // Keep the one with better confidence or larger area
      const predArea = pred.width * pred.height;
      const existingArea = duplicate.width * duplicate.height;
      if (pred.confidence > duplicate.confidence || predArea > existingArea) {
        const index = unique.indexOf(duplicate);
        unique[index] = pred;
      }
    }
  }

  console.log(
    `   ✓ After text deduplication: ${unique.length} (removed ${predictions.length - unique.length})`,
  );

  return unique;
}

async function saveOCRPredictions(
  ocrPredictions: OCRPrediction[],
  pageName: string,
  outDir: string,
  metadata: {
    invalidOCRTextCount: number;
    deduplicatedOCRTextCount: number;
    totalOCRTextCount: number;
    estMinutesNeeded: number;
  },
) {
  const ocrPredictionsFile = join(outDir, `${pageName}-ocr-predictions.json`);
  await fs.writeFile(
    ocrPredictionsFile,
    JSON.stringify(
      {
        page: pageName,
        timestamp: new Date().toISOString(),
        totalPredictions: ocrPredictions.length,
        totalTextChars: metadata.totalOCRTextCount,
        elevenLabsMinutesNeeded: metadata.estMinutesNeeded,
        removed: {
          invalidText: metadata.invalidOCRTextCount,
          textDuplicates: metadata.deduplicatedOCRTextCount,
        },
        predictions: ocrPredictions,
      },
      null,
      2,
    ),
  );
  console.log(`   💾 Saved OCR predictions to: ${ocrPredictionsFile}`);
}

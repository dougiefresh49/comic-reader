import fs from "fs-extra";
import { GEMINI_HIGH } from "./models.js";
import {
  createPartFromBase64,
  createPartFromText,
  type GoogleGenAI,
} from "@google/genai";
import type { Box2D } from "./box-math";
import type { OCRPrediction } from "./ocr-viewer";
import { join } from "path";
import { buildContextPrompt } from "~/lib/gemini-prompts.js";

export interface Bubble {
  id: string;
  box_2d: Box2D;
  ocr_text: string;
  type: "SPEECH" | "NARRATION" | "CAPTION" | "SFX" | "BACKGROUND";
  speaker: string | null;
  emotion: string;
  characterType?: "MAJOR" | "MINOR" | "EXTRA";
  side?: "HERO" | "VILLAIN" | "NEUTRAL";
  voiceDescription?: string;
  textWithCues?: string;
  aiReasoning?: string;
  ignored?: boolean;
  needsAudio?: boolean;
  needsOcr?: boolean;
  style?: { left?: string; top?: string; width?: string; height?: string };
}

export async function analyzeContext(
  gemini: GoogleGenAI,
  imageBuffer: Buffer,
  ocrPredictions: OCRPrediction[],
  pageName: string,
  options: {
    skipGemini?: boolean;
    outDir: string;
    additionalContext?: string;
  },
): Promise<{
  bubbles: Bubble[];
  skipped: Array<{ text: string; reason: string }>;
}> {
  // Step 3: Context analysis with Gemini
  if (options.skipGemini) {
    console.log(
      `\n🤖 Analyzing context with Gemini... SKIPPED (--skip-gemini)`,
    );
    console.log(
      `\n✅ Stopping before Gemini analysis. Review OCR results in viewer file`,
    );
    return { bubbles: [], skipped: [] };
  }

  console.log(`\n🤖 Analyzing context with Gemini...`);
  const bubbles: Bubble[] = [];
  const skipped: Array<{ text: string; reason: string }> = [];
  const uniqueCharacters = new Set<string>();

  for (let i = 0; i < ocrPredictions.length; i++) {
    const { ocr_text, ...box } = ocrPredictions[i]!;
    const textPreview =
      ocr_text.slice(0, 40) + (ocr_text.length > 40 ? "..." : "");

    // if (i === 0) {
    console.log(
      `   [${i + 1}/${ocrPredictions.length}] Analyzing: "${textPreview}"`,
    );
    // } else {
    //   console.log(
    // `   [${i + 1}/${ocrPredictions.length}] Skipping: "${textPreview}"`,
    //   );
    //   continue;
    // }

    try {
      const context = await analyzeContextGemini(
        gemini,
        imageBuffer,
        ocr_text,
        box,
        Array.from(uniqueCharacters),
        options.additionalContext,
      );

      console.log(
        `      → Type: ${context.type}, Speaker: ${context.speaker ?? "null"}, Emotion: ${context.emotion}`,
      );

      // Wait 2 seconds between API calls to prevent rate limiting
      // Skip delay on last iteration
      if (i < ocrPredictions.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      // Filter out SFX and BACKGROUND
      if (context.type === "SFX" || context.type === "BACKGROUND") {
        skipped.push({
          text: ocr_text,
          reason: `Type: ${context.type}`,
        });
        console.log(`      ⏭️  Skipped (${context.type})`);
        continue;
      }

      // Generate bubble ID
      const bubbleId = `${pageName}_b${String(i + 1).padStart(2, "0")}`;

      // Handle NARRATION and CAPTION types
      const speaker =
        context.type === "NARRATION" || context.type === "CAPTION"
          ? "Narrator"
          : context.speaker;
      const emotion =
        context.type === "NARRATION" || context.type === "CAPTION"
          ? "Neutral"
          : context.emotion;

      !!speaker && uniqueCharacters.add(speaker);

      bubbles.push({
        id: bubbleId,
        box_2d: box,
        ocr_text,
        type: context.type as Bubble["type"],
        speaker,
        emotion,
        characterType: context.characterType,
        side: context.side,
        voiceDescription: context.voiceDescription,
        textWithCues: context.textWithCues,
        aiReasoning: context.aiReasoning,
      });
    } catch (error) {
      console.error(`      ❌ Error analyzing bubble ${i + 1}:`, error);
      skipped.push({
        text: ocr_text,
        reason: `Error: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  // write bubbles to file
  await fs.writeFile(
    join(options.outDir, `${pageName}-gemini-context.json`),
    JSON.stringify(bubbles, null, 2),
  );
  return { bubbles, skipped };
}

/* helper functions */
/**
 * Analyze context using Gemini API
 * Exported for use in backfill scripts
 */
export async function analyzeContextGemini(
  gemini: GoogleGenAI,
  imageBuffer: Buffer,
  targetText: string,
  targetLocation: Box2D,
  uniqueCharacters: string[],
  additionalContext?: string,
): Promise<{
  type: string;
  speaker: string | null;
  emotion: string;
  characterType?: "MAJOR" | "MINOR" | "EXTRA";
  side?: "HERO" | "VILLAIN" | "NEUTRAL";
  voiceDescription?: string;
  textWithCues?: string;
  aiReasoning?: string;
}> {
  const base64Image = imageBuffer.toString("base64");

  const prompt = getGeminiPrompt(
    targetText,
    targetLocation,
    uniqueCharacters,
    additionalContext,
  );

  try {
    const imagePart = createPartFromBase64(base64Image, "image/jpeg");
    const textPart = createPartFromText(prompt);

    const response = await gemini.models.generateContent({
      model: GEMINI_HIGH,
      contents: [imagePart, textPart],
    });

    const text = response.text;
    if (!text) {
      throw new Error("No text response from Gemini");
    }

    // Extract scratchpad content (between <scratchpad> and </scratchpad>)
    let aiReasoning: string | undefined;
    const scratchpadMatch = text.match(/<scratchpad>([\s\S]*?)<\/scratchpad>/i);
    if (scratchpadMatch) {
      aiReasoning = scratchpadMatch[1]?.trim();
    }

    // Extract JSON from response (handle markdown code blocks and explanatory text)
    let jsonText = text.trim();

    // Remove markdown code blocks
    if (jsonText.includes("```json")) {
      const jsonBlockMatch = jsonText.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonBlockMatch) {
        jsonText = jsonBlockMatch[1]?.trim() ?? jsonText;
      }
    } else if (jsonText.includes("```")) {
      const codeBlockMatch = jsonText.match(/```\s*([\s\S]*?)\s*```/);
      if (codeBlockMatch) {
        jsonText = codeBlockMatch[1]?.trim() ?? jsonText;
      }
    }

    // Try to extract JSON object from text that might have explanatory text
    // Look for JSON object pattern: { ... }
    const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonText = jsonMatch[0];
    }

    // Log the raw response for debugging
    if (jsonText !== text.trim()) {
      console.log(`    ⚠️  Gemini response had extra text, extracted JSON`);
    }

    let parsed: {
      type?: string;
      speaker?: string | null;
      emotion?: string;
      characterType?: "MAJOR" | "MINOR" | "EXTRA";
      side?: "HERO" | "VILLAIN" | "NEUTRAL";
      voiceDescription?: string;
      textWithCues?: string;
    };

    try {
      parsed = JSON.parse(jsonText) as typeof parsed;
    } catch (parseError) {
      console.error(`    ❌ Failed to parse Gemini JSON response:`);
      console.error(`    Raw text: ${text.substring(0, 200)}...`);
      console.error(`    Extracted JSON: ${jsonText.substring(0, 200)}...`);
      throw parseError;
    }

    return {
      type: parsed.type ?? "SPEECH",
      speaker: parsed.speaker ?? null,
      emotion: parsed.emotion ?? "neutral",
      characterType: parsed.characterType,
      side: parsed.side,
      voiceDescription: parsed.voiceDescription,
      textWithCues: parsed.textWithCues,
      aiReasoning,
    };
  } catch (error) {
    console.error(`Error analyzing context for text "${targetText}":`, error);
    // Return defaults on error
    return {
      type: "SPEECH",
      speaker: null,
      emotion: "neutral",
    };
  }
}

function getGeminiPrompt(
  targetText: string,
  targetLocation: Box2D,
  uniqueCharacters: string[],
  additionalContext?: string,
) {
  return buildContextPrompt(
    targetText,
    targetLocation,
    uniqueCharacters,
    additionalContext,
  );
}

import {
  createPartFromBase64,
  createPartFromText,
  type GoogleGenAI,
} from "@google/genai";
import type { Box2D } from "./box-math";
import type { OCRPrediction } from "./ocr-viewer";

export interface Bubble {
  id: string;
  box_2d: Box2D;
  ocr_text: string;
  type: "SPEECH" | "NARRATION" | "CAPTION" | "SFX" | "BACKGROUND";
  speaker: string | null;
  emotion: string;
  ignored?: boolean;
}

export async function analyzeContext(
  gemini: GoogleGenAI,
  imageBuffer: Buffer,
  ocrPredictions: OCRPrediction[],
  pageName: string,
  options: {
    skipGemini?: boolean;
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

  for (let i = 0; i < ocrPredictions.length; i++) {
    const { ocr_text, ...box } = ocrPredictions[i]!;
    const textPreview =
      ocr_text.slice(0, 40) + (ocr_text.length > 40 ? "..." : "");

    console.log(
      `   [${i + 1}/${ocrPredictions.length}] Analyzing: "${textPreview}"`,
    );

    try {
      const context = await analyzeContextGemini(
        gemini,
        imageBuffer,
        ocr_text,
        box,
      );

      console.log(
        `      → Type: ${context.type}, Speaker: ${context.speaker ?? "null"}, Emotion: ${context.emotion}`,
      );

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

      bubbles.push({
        id: bubbleId,
        box_2d: box,
        ocr_text,
        type: context.type as Bubble["type"],
        speaker,
        emotion,
      });
    } catch (error) {
      console.error(`      ❌ Error analyzing bubble ${i + 1}:`, error);
      skipped.push({
        text: ocr_text,
        reason: `Error: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return { bubbles, skipped };
}

/* helper functions */
/**
 * Analyze context using Gemini API
 */
async function analyzeContextGemini(
  gemini: GoogleGenAI,
  imageBuffer: Buffer,
  targetText: string,
  targetLocation: Box2D,
): Promise<{ type: string; speaker: string | null; emotion: string }> {
  const base64Image = imageBuffer.toString("base64");

  const prompt = `I am providing a full comic book page.
  **Goal:** Analyze the specific text region described below to determine how it should be voice-acted.
  
  **Target Region:**
  * **Text:** "${targetText}"
  * **Location:** x:${targetLocation.x}, y:${targetLocation.y} (width:${targetLocation.width}, height:${targetLocation.height})
  
  **Instructions:**
  
  1.  **Locate & Classify:** Find the text on the page. Classify it as one of:
      * \`SPEECH\`: Character dialogue (look for a tail pointing to a character).
      * \`NARRATION\`: Square/Rectangular boxes (Storyteller).
      * \`CAPTION\`: Floating structural text ("The End", "NYC").
      * \`SFX\`: Sound effects drawn into the art (BOOM, KRAASH).
      * \`BACKGROUND\`: Text not meant to be read (signs, graffiti, license plates).
  
  2.  **Analyze Context (The "Why"):**
      * **Speaker:** If SPEECH, trace the bubble's tail. Who is it?
      * **Importance:** Is this a MAIN character (Hero/Villain) or a MINOR character (Civilian/Guard)?
      * **Voice Description:** If MINOR, describe their voice (e.g., "Gruff male, British accent").
      * **Emotion:** Look at the character's eyebrows, mouth, and body language.
  
  **Output Format:**
  First, think step-by-step in a <scratchpad> block to confirm your reasoning.
  Then, provide the final JSON.
  
  **Example Output:**
  <scratchpad>
  I see the text "Cowabunga!". It is in a round white bubble.
  The tail points to the turtle with the orange mask (Michelangelo).
  He is smiling and jumping. This is a MAIN character.
  </scratchpad>
  \`\`\`json
  {
    "type": "SPEECH",
    "speaker": "Michelangelo",
    "character_type": "MAJOR",
    "voice_description": null,
    "emotion": "excited"
  }
  \`\`\`
  `;

  try {
    const imagePart = createPartFromBase64(base64Image, "image/jpeg");
    const textPart = createPartFromText(prompt);

    const response = await gemini.models.generateContent({
      model: "gemini-3-pro-preview",
      contents: [imagePart, textPart],
    });

    const text = response.text;
    if (!text) {
      throw new Error("No text response from Gemini");
    }

    // Extract JSON from response (handle markdown code blocks and explanatory text)
    let jsonText = text.trim();

    // Remove markdown code blocks
    if (jsonText.startsWith("```")) {
      jsonText = jsonText
        .replace(/^```json\s*/, "")
        .replace(/^```\s*/, "")
        .replace(/\s*```$/, "");
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

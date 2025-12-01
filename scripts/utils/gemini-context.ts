import fs from "fs-extra";
import {
  createPartFromBase64,
  createPartFromText,
  type GoogleGenAI,
} from "@google/genai";
import type { Box2D } from "./box-math";
import type { OCRPrediction } from "./ocr-viewer";
import { join } from "path";

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
}

export async function analyzeContext(
  gemini: GoogleGenAI,
  imageBuffer: Buffer,
  ocrPredictions: OCRPrediction[],
  pageName: string,
  options: {
    skipGemini?: boolean;
    outDir: string;
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

  const prompt = getGeminiPrompt(targetText, targetLocation, uniqueCharacters);

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
) {
  const characterList = uniqueCharacters
    .map((character) => `- ${character}`)
    .join("\n");
  const prompt = `I am providing a full comic book page.
**Goal:** Analyze the specific text region described below to determine how it should be voice-acted.

**Target Region:**
* **Text:** "${targetText}"
* **Location:** x:${targetLocation.x}, y:${targetLocation.y} (width:${targetLocation.width}, height:${targetLocation.height})
* **Unique Characters:**
${characterList}

**Instructions:**

1.  **Locate & Classify:** Find the text on the page. Classify it as one of:
    * \`SPEECH\`: Character dialogue (look for a tail pointing to a character).
    * \`NARRATION\`: Square/Rectangular boxes (Storyteller).
    * \`CAPTION\`: Floating structural text ("The End", "NYC").
    * \`SFX\`: Sound effects drawn into the art (BOOM, KRAASH).
    * \`BACKGROUND\`: Text not meant to be read (signs, graffiti, license plates).

2.  **Analyze Context (The "Why"):**
    * **Speaker:** If SPEECH, trace the bubble's tail. Who is it? Above is a list of unique characters already identified in the book. If the speaker in this panel looks like one of these characters, reuse the exact name. Only create a new name if it is clearly a different character.
    * **Side:** Is the speaker a \`HERO\`, \`VILLAIN\`, or \`NEUTRAL\` party?
    * **Importance:**
        * \`MAJOR\`: Main cast (Turtles, Rangers, Shredder, Rita).
        * \`MINOR\`: Named secondary characters (e.g., "Bulk", "Skull").
        * \`EXTRA\`: Generic/Unnamed (e.g., "Foot Soldier", "Civilian", "Reporter").
    * **Voice Description:** If MINOR or EXTRA, describe their voice for an AI generator. Use their "Side" to influence the tone. (e.g., "Villain Extra: Raspy, aggressive, threatening male voice").
    * **Emotion:** Look at the character's eyebrows, mouth, and body language.

3.  **Performance Cues (CRITICAL):**
    Rewrite the text to guide the voice actor. Use these rules:
    * **Stuttering:** If the character looks scared or text has "...", add stutters like "I-I don't know..."
    * **Volume:** If text is bold or bubble is jagged, add \`[Shouting]\` or \`[Screaming]\` at the start.
    * **Whisper:** If bubble is dotted, add \`[Whispering]\`.
    * **Tone:** Add natural language cues in brackets like \`[sighs]\`, \`[laughs]\`, \`[grunts]\`, or \`[sarcastically]\`.

**Output Format:**
First, think step-by-step in a <scratchpad> block to confirm your reasoning.
Then, provide the final JSON.

**Example Output:**
<scratchpad>
I see the text "You'll never win!". It is in a jagged bubble.
The speaker is a generic Foot Soldier (Villain). He is attacking.
Importance is EXTRA. He is shouting.
</scratchpad>
\`\`\`json
{
  "type": "SPEECH",
  "speaker": "Foot Soldier",
  "characterType": "EXTRA",
  "side": "VILLAIN",
  "voiceDescription": "Aggressive, raspy male voice, American accent, high energy",
  "emotion": "shouting",
  "textWithCues": "[Shouting aggressively] You'll never win!"
}
\`\`\`
`;
  return prompt;
}

import {
  GoogleGenAI,
  createPartFromBase64,
  createPartFromText,
  type Part,
} from "@google/genai";
import { GEMINI_MEDIUM } from "./models.js";
import type { FaceCrop } from "./face-extraction.js";

export interface CharacterCluster {
  id: number;
  characterName: string | null;
  confidence: number;
  exemplar: FaceCrop;
  memberCount: number;
}

interface MatchResult {
  matchedClusterId: number | null;
  characterName: string | null;
  confidence: number;
}

const MAX_EXEMPLARS_PER_COMPARISON = 4;

function buildComparisonPrompt(
  knownCharacters: string[],
  clusterCount: number,
): string {
  const charList =
    knownCharacters.length > 0
      ? `\nKnown characters in this comic: ${knownCharacters.join(", ")}`
      : "";

  return `You are comparing comic book character faces to determine if a new face matches any existing character cluster.

You will see:
- A NEW face crop (the first image)
- Then ${clusterCount} existing cluster exemplar(s) (subsequent images, labeled cluster_0, cluster_1, etc.)

RULES:
1. Compare the NEW face to each cluster exemplar based on: skin color/type, mask/helmet, hair, costume color, species (human vs turtle vs robot etc.)
2. If the NEW face clearly matches one cluster, return that cluster ID and the character name if you know it.
3. If you are NOT SURE, say so. Do NOT guess. Return matched_cluster: null.
4. Comic art style makes characters look similar — focus on distinguishing features, not art style.
${charList}

Output JSON only (no markdown fences):
{"matched_cluster": 0, "character_name": "Leonardo", "confidence": 0.9, "reasoning": "Blue mask, green skin, matches cluster_0"}

If no match or unsure:
{"matched_cluster": null, "character_name": null, "confidence": 0, "reasoning": "Does not clearly match any existing cluster"}`;
}

function buildIdentifyPrompt(knownCharacters: string[]): string {
  const charList =
    knownCharacters.length > 0
      ? `Known characters in this comic: ${knownCharacters.join(", ")}`
      : "No character list available.";

  return `You are identifying a comic book character from a face crop.

${charList}

RULES:
1. Based on visual features (skin color, mask, helmet, hair, costume, species), identify who this character is.
2. Use the known characters list if the character matches one.
3. If you are NOT SURE who this character is, set character_name to null. Do NOT guess.
4. Only provide a name if you are genuinely confident.

Output JSON only (no markdown fences):
{"character_name": "Leonardo", "confidence": 0.9, "reasoning": "Blue mask, green skin — TMNT Leonardo"}

If unsure:
{"character_name": null, "confidence": 0, "reasoning": "Cannot confidently identify this character"}`;
}

export async function matchFaceToClusters(
  gemini: GoogleGenAI,
  face: FaceCrop,
  clusters: CharacterCluster[],
  knownCharacters: string[],
): Promise<MatchResult> {
  if (clusters.length === 0) {
    return { matchedClusterId: null, characterName: null, confidence: 0 };
  }

  const exemplars = clusters.slice(0, MAX_EXEMPLARS_PER_COMPARISON);
  const prompt = buildComparisonPrompt(knownCharacters, exemplars.length);

  const parts: Part[] = [
    createPartFromText(prompt),
    createPartFromText("NEW face:"),
    createPartFromBase64(face.imageBuffer.toString("base64"), "image/webp"),
  ];

  for (const cluster of exemplars) {
    parts.push(
      createPartFromText(
        `cluster_${cluster.id}${cluster.characterName ? ` (${cluster.characterName})` : ""}:`,
      ),
    );
    parts.push(
      createPartFromBase64(
        cluster.exemplar.imageBuffer.toString("base64"),
        "image/webp",
      ),
    );
  }

  try {
    const response = await gemini.models.generateContent({
      model: GEMINI_MEDIUM,
      contents: [{ role: "user", parts }],
    });

    const text = response.text?.trim() ?? "";
    const cleaned = text
      .replace(/^```json\s*/i, "")
      .replace(/```\s*$/, "")
      .trim();
    const parsed = JSON.parse(cleaned) as {
      matched_cluster: number | null;
      character_name: string | null;
      confidence: number;
      reasoning: string;
    };

    return {
      matchedClusterId: parsed.matched_cluster,
      characterName: parsed.character_name,
      confidence: parsed.confidence,
    };
  } catch {
    return { matchedClusterId: null, characterName: null, confidence: 0 };
  }
}

export async function identifySingleFace(
  gemini: GoogleGenAI,
  face: FaceCrop,
  knownCharacters: string[],
): Promise<{ characterName: string | null; confidence: number }> {
  const prompt = buildIdentifyPrompt(knownCharacters);
  const parts: Part[] = [
    createPartFromText(prompt),
    createPartFromBase64(face.imageBuffer.toString("base64"), "image/webp"),
  ];

  try {
    const response = await gemini.models.generateContent({
      model: GEMINI_MEDIUM,
      contents: [{ role: "user", parts }],
    });

    const text = response.text?.trim() ?? "";
    const cleaned = text
      .replace(/^```json\s*/i, "")
      .replace(/```\s*$/, "")
      .trim();
    const parsed = JSON.parse(cleaned) as {
      character_name: string | null;
      confidence: number;
    };

    return {
      characterName: parsed.character_name,
      confidence: parsed.confidence,
    };
  } catch {
    return { characterName: null, confidence: 0 };
  }
}

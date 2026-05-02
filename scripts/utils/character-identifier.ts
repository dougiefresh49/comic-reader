import {
  GoogleGenAI,
  createPartFromBase64,
  createPartFromText,
  type Part,
} from "@google/genai";
import { GEMINI_HIGH } from "./models.js";
import type { FaceCrop } from "./face-extraction.js";
import type { Cluster } from "./clustering.js";
import type { CharacterRoster } from "../types/book-config.js";
import { formatRosterForPrompt } from "./roster.js";

export interface ClusterIdentification {
  clusterId: number;
  characterName: string;
  confidence: number;
  reasoning: string;
  isNewCharacter: boolean;
}

const MAX_CROPS_PER_CLUSTER = 6;

function pickRepresentativeCrops(
  cluster: Cluster,
  crops: FaceCrop[],
): FaceCrop[] {
  const members = cluster.memberIndices
    .map((i) => crops[i]!)
    .sort((a, b) => b.confidence - a.confidence);
  return members.slice(0, MAX_CROPS_PER_CLUSTER);
}

export async function identifyClusters(
  gemini: GoogleGenAI,
  clusters: Cluster[],
  crops: FaceCrop[],
  context: {
    bookTitle: string;
    characterContext: string;
    roster: CharacterRoster;
    wikiAppearances: string | null;
  },
): Promise<ClusterIdentification[]> {
  const results: ClusterIdentification[] = [];
  const alreadyIdentified: string[] = [];

  for (const cluster of clusters) {
    const reps = pickRepresentativeCrops(cluster, crops);
    if (reps.length === 0) continue;

    const rosterText = formatRosterForPrompt(context.roster);
    const alreadyText =
      alreadyIdentified.length > 0
        ? `Characters already identified in other clusters (do NOT reuse): ${alreadyIdentified.join(", ")}`
        : "";
    const wikiText = context.wikiAppearances
      ? `Wiki appearances for this issue:\n${context.wikiAppearances}`
      : "";

    const prompt = `You are identifying a comic book character from multiple face crops of the same character.

**Book**: ${context.bookTitle}
**Character context**: ${context.characterContext}

${rosterText}
${alreadyText}
${wikiText}

**Instructions:**
1. These ${reps.length} image(s) show the SAME character from different panels.
2. Based on visual features (costume color, mask, skin color, species, hair, body type), identify who this character is.
3. Match to a character from the roster or wiki appearances using the canonical name.
4. If this is genuinely a new character not in the roster, provide the best canonical name.

**Output JSON only (no markdown fences):**
{"character_name": "Raphael", "confidence": 0.95, "reasoning": "Red mask, green skin — matches TMNT Raphael", "is_new_character": false}`;

    const parts: Part[] = [createPartFromText(prompt)];
    for (const rep of reps) {
      parts.push(
        createPartFromBase64(rep.imageBuffer.toString("base64"), "image/webp"),
      );
    }

    try {
      const response = await gemini.models.generateContent({
        model: GEMINI_HIGH,
        contents: [{ role: "user", parts }],
      });

      const text = response.text?.trim() ?? "";
      const cleaned = text
        .replace(/^```json\s*/i, "")
        .replace(/```\s*$/, "")
        .trim();
      const parsed = JSON.parse(cleaned) as {
        character_name: string;
        confidence: number;
        reasoning: string;
        is_new_character: boolean;
      };

      results.push({
        clusterId: cluster.id,
        characterName: parsed.character_name,
        confidence: parsed.confidence,
        reasoning: parsed.reasoning,
        isNewCharacter: parsed.is_new_character,
      });

      alreadyIdentified.push(parsed.character_name);
      console.log(
        `   ✓ cluster ${cluster.id} (${cluster.memberIndices.length} faces) → ${parsed.character_name} (${(parsed.confidence * 100).toFixed(0)}%)`,
      );
    } catch (err) {
      console.warn(
        `   ⚠ cluster ${cluster.id} identification failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      results.push({
        clusterId: cluster.id,
        characterName: `Unknown_Cluster_${cluster.id}`,
        confidence: 0,
        reasoning: "Identification failed",
        isNewCharacter: true,
      });
    }
  }

  return results;
}

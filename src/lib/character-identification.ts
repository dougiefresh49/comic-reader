import {
  GoogleGenAI,
  createPartFromBase64,
  createPartFromText,
  type Part,
} from "@google/genai";
import type { SupabaseClient } from "@supabase/supabase-js";
import { GEMINI_MEDIUM } from "./models";

export interface FaceIdentification {
  characterName: string | null;
  confidence: number;
  reasoning?: string;
}

export interface ExemplarReference {
  characterName: string;
  jpegBase64: string;
  confidence: number;
}

function buildIdentifyPrompt(
  knownCharacters: string[],
  hasPageContext: boolean,
): string {
  const charList =
    knownCharacters.length > 0
      ? `Known characters in this comic: ${knownCharacters.join(", ")}`
      : "No character list available.";

  const contextNote = hasPageContext
    ? `You will see TWO images:
1. The FULL COMIC PAGE — use this for context (scene, costume, body, speech bubbles, surrounding characters)
2. The CROPPED FACE — this is the specific character to identify

Use the full page to understand who the character is. The crop alone may be ambiguous (e.g. just an eye or chin), but the full page shows costume, body, dialogue, and scene context.`
    : "You will see a single cropped face image.";

  return `You are identifying a comic book character.

${charList}

${contextNote}

RULES:
1. Based on visual features (skin color, mask, helmet, hair, costume, species) AND page context (dialogue, scene, body visible in full page), identify who this character is.
2. Use the known characters list if the character matches one.
3. If you are NOT SURE who this character is, set character_name to null. Do NOT guess.
4. Only provide a name if you are genuinely confident.

Output JSON only (no markdown fences):
{"character_name": "Leonardo", "confidence": 0.9, "reasoning": "Blue mask, green skin — TMNT Leonardo"}

If unsure:
{"character_name": null, "confidence": 0, "reasoning": "Cannot confidently identify this character"}`;
}

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

export async function identifyFace(
  gemini: GoogleGenAI,
  faceImageBase64: string,
  faceImageMimeType: string,
  knownCharacters: string[],
  exemplars?: ExemplarReference[],
  pageImageBase64?: string,
  pageImageMimeType?: string,
): Promise<FaceIdentification> {
  const hasPage = !!pageImageBase64;
  const prompt = buildIdentifyPrompt(knownCharacters, hasPage);
  const parts: Part[] = [createPartFromText(prompt)];

  if (pageImageBase64 && pageImageMimeType) {
    parts.push(
      createPartFromText("FULL PAGE:"),
      createPartFromBase64(pageImageBase64, pageImageMimeType),
    );
  }

  parts.push(
    createPartFromText(hasPage ? "CROPPED FACE:" : "Face crop:"),
    createPartFromBase64(faceImageBase64, faceImageMimeType),
  );

  if (exemplars && exemplars.length > 0) {
    parts.push(
      createPartFromText(
        "\nConfirmed character examples (use as visual reference):",
      ),
    );
    for (const ex of exemplars) {
      parts.push(
        createPartFromText(
          `${ex.characterName} (${(ex.confidence * 100).toFixed(0)}% confidence):`,
        ),
      );
      parts.push(createPartFromBase64(ex.jpegBase64, "image/jpeg"));
    }
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
    const jsonMatch = /\{[\s\S]*\}/.exec(cleaned);
    if (!jsonMatch) return { characterName: null, confidence: 0 };

    const parsed = JSON.parse(jsonMatch[0]) as {
      character_name: string | null;
      confidence: number;
      reasoning?: string;
    };

    return {
      characterName: parsed.character_name,
      confidence: parsed.confidence,
      reasoning: parsed.reasoning,
    };
  } catch {
    return { characterName: null, confidence: 0 };
  }
}

export interface ClusterExemplar {
  id: number;
  characterName: string | null;
  imageBase64: string;
  imageMimeType: string;
}

export interface ClusterMatchResult {
  matchedClusterId: number | null;
  characterName: string | null;
  confidence: number;
}

export async function matchFaceToClusters(
  gemini: GoogleGenAI,
  faceImageBase64: string,
  faceImageMimeType: string,
  clusters: ClusterExemplar[],
  knownCharacters: string[],
): Promise<ClusterMatchResult> {
  if (clusters.length === 0) {
    return { matchedClusterId: null, characterName: null, confidence: 0 };
  }

  const exemplars = clusters.slice(0, 4);
  const prompt = buildComparisonPrompt(knownCharacters, exemplars.length);

  const parts: Part[] = [
    createPartFromText(prompt),
    createPartFromText("NEW face:"),
    createPartFromBase64(faceImageBase64, faceImageMimeType),
  ];

  for (const cluster of exemplars) {
    parts.push(
      createPartFromText(
        `cluster_${cluster.id}${cluster.characterName ? ` (${cluster.characterName})` : ""}:`,
      ),
    );
    parts.push(
      createPartFromBase64(cluster.imageBase64, cluster.imageMimeType),
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

export async function resolveCharacterId(
  supabase: SupabaseClient,
  name: string,
): Promise<string | null> {
  const directId = name.toLowerCase().replace(/\s+/g, "-");
  const { data: direct } = await supabase
    .from("characters")
    .select("id")
    .eq("id", directId)
    .single();
  if (direct) return directId;

  const { data: byAlias } = await supabase
    .from("characters")
    .select("id, aliases")
    .limit(200);

  if (byAlias) {
    for (const row of byAlias) {
      const aliases = (row.aliases as string[]) ?? [];
      if (aliases.some((a) => a.toLowerCase() === name.toLowerCase())) {
        return row.id as string;
      }
    }
  }

  return null;
}

export async function buildKnownCharacterList(
  supabase: SupabaseClient,
  bookId: string,
): Promise<string[]> {
  const { data: chars } = await supabase
    .from("characters")
    .select("id, aliases")
    .eq("book_id", bookId);

  const names: string[] = [];
  for (const c of chars ?? []) {
    const id = c.id as string;
    names.push(id.replace(/-/g, " "));
    const aliases = c.aliases as string[] | null;
    if (aliases) names.push(...aliases);
  }
  return names;
}

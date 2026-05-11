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
  issueContext?: string,
): string {
  const charList =
    knownCharacters.length > 0
      ? `Named characters who may appear: ${knownCharacters.join(", ")}`
      : "";

  const synopsis = issueContext ? `Issue synopsis: ${issueContext}` : "";

  const contextNote = hasPageContext
    ? `You will see TWO images:
1. FULL COMIC PAGE — use for context (scene, costume, body, speech bubbles, surrounding characters)
2. CROPPED FACE — the specific face to identify

The crop alone may be ambiguous. Use the full page to see costume, body, dialogue, and scene.`
    : "You will see a single cropped face image.";

  return `You are identifying a character in a comic book panel.

${contextNote}
${charList ? `\n${charList}` : ""}
${synopsis ? `\n${synopsis}` : ""}

IDENTIFICATION RULES:
1. Identify based on visual features (skin color, mask, helmet, hair, costume, species) AND page context (dialogue, scene, body).
2. If the face matches a named character from the list above, use that name.
3. If the face is a MINION or generic enemy (Foot Soldier, Putty Patroller, robot, unnamed soldier, etc.), use the group name (e.g. "Foot Soldier", "Putty", "Rock Soldier"). Do NOT try to match minions to named characters.
4. If the crop shows only a body part (fist, arm, torso) without a recognizable face, set character_name to null.
5. If you cannot confidently identify the character, set character_name to null. Do NOT guess or pick a random name from the list.

CONFIDENCE GUIDELINES:
- 0.95: Unmistakable — unique visual features clearly visible (e.g. green skin + blue mask = Leonardo)
- 0.85: Very likely — strong visual match with supporting context
- 0.70: Probable — some features match but crop is partial or ambiguous
- Below 0.60: Too uncertain — set character_name to null instead

Output JSON only (no markdown fences):
{"character_name": "Leonardo", "confidence": 0.85, "reasoning": "Blue mask, green skin, holding katana — TMNT Leonardo"}

If minion/generic enemy:
{"character_name": "Foot Soldier", "confidence": 0.80, "reasoning": "Dark ninja outfit, generic foot clan soldier"}

If unsure or not a face:
{"character_name": null, "confidence": 0, "reasoning": "Crop shows only a green fist, no identifiable face"}`;
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
  issueContext?: string,
): Promise<FaceIdentification> {
  const hasPage = !!pageImageBase64;
  const prompt = buildIdentifyPrompt(knownCharacters, hasPage, issueContext);
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

  const { data: allChars } = await supabase
    .from("characters")
    .select("id, aliases")
    .limit(200);

  if (allChars) {
    for (const row of allChars) {
      const id = row.id as string;
      const aliases = (row.aliases as string[]) ?? [];
      if (fuzzyNameMatch(name, id)) return id;
      if (aliases.some((a) => fuzzyNameMatch(name, a))) return id;
    }
  }

  return null;
}

export async function buildKnownCharacterList(
  supabase: SupabaseClient,
  bookId: string,
): Promise<string[]> {
  const { data: book } = await supabase
    .from("books")
    .select("franchises")
    .eq("id", bookId)
    .single();

  const franchises = (book?.franchises as string[] | null) ?? [];

  let chars: Array<{ id: string; aliases: string[] | null }>;
  if (franchises.length > 0) {
    const franchiseFilter = franchises
      .map((f) => `franchise.eq.${f}`)
      .join(",");
    const { data } = await supabase
      .from("characters")
      .select("id, aliases")
      .or(`${franchiseFilter},franchise.is.null`);
    chars = (data ?? []) as Array<{ id: string; aliases: string[] | null }>;
  } else {
    const { data } = await supabase.from("characters").select("id, aliases");
    chars = (data ?? []) as Array<{ id: string; aliases: string[] | null }>;
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

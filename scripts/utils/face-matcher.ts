import type { GoogleGenAI } from "@google/genai";
import {
  identifyFace,
  matchFaceToClusters as _matchFaceToClusters,
  type ExemplarReference,
  type ClusterMatchResult,
} from "~/lib/character-identification.js";
import type { FaceCrop } from "./face-extraction.js";

export type { ExemplarReference };

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

export async function matchFaceToClusters(
  gemini: GoogleGenAI,
  face: FaceCrop,
  clusters: CharacterCluster[],
  knownCharacters: string[],
): Promise<MatchResult> {
  const clusterExemplars = clusters.slice(0, 4).map((c) => ({
    id: c.id,
    characterName: c.characterName,
    imageBase64: c.exemplar.imageBuffer.toString("base64"),
    imageMimeType: "image/webp",
  }));

  const result: ClusterMatchResult = await _matchFaceToClusters(
    gemini,
    face.imageBuffer.toString("base64"),
    "image/webp",
    clusterExemplars,
    knownCharacters,
  );

  return {
    matchedClusterId: result.matchedClusterId,
    characterName: result.characterName,
    confidence: result.confidence,
  };
}

export async function identifySingleFace(
  gemini: GoogleGenAI,
  face: FaceCrop,
  knownCharacters: string[],
  exemplars?: ExemplarReference[],
): Promise<{ characterName: string | null; confidence: number }> {
  return identifyFace(
    gemini,
    face.imageBuffer.toString("base64"),
    "image/webp",
    knownCharacters,
    exemplars,
  );
}

import { supabase } from "../lib/supabase.js";
import {
  storeExemplar as _storeExemplar,
  findSimilarExemplars as _findSimilarExemplars,
  downloadExemplarImage as _downloadExemplarImage,
  type StoreExemplarParams,
  type ExemplarMatch,
} from "~/lib/exemplar-store.js";
import { resolveCharacterId as _resolveCharacterId } from "~/lib/character-identification.js";
import type { CharacterCluster } from "./face-matcher.js";

export type { StoreExemplarParams, ExemplarMatch };

export async function storeExemplar(
  params: StoreExemplarParams,
): Promise<string> {
  return _storeExemplar(supabase, params);
}

export async function findSimilarExemplars(
  jpegBuffer: Buffer,
  bookIds: string[],
  limit = 5,
): Promise<ExemplarMatch[]> {
  return _findSimilarExemplars(
    supabase,
    jpegBuffer.toString("base64"),
    bookIds,
    limit,
  );
}

export async function downloadExemplarImage(
  cropPath: string,
): Promise<Buffer | null> {
  return _downloadExemplarImage(supabase, cropPath);
}

export async function resolveCharacterId(name: string): Promise<string | null> {
  return _resolveCharacterId(supabase, name);
}

export async function seedFromExistingClusters(
  clusters: CharacterCluster[],
  bookId: string,
  sourceIssue: string,
  confidenceThreshold = 0.7,
): Promise<number> {
  const qualifying = clusters.filter(
    (c) => c.characterName !== null && c.confidence >= confidenceThreshold,
  );

  let seeded = 0;
  for (const cluster of qualifying) {
    const characterId = await resolveCharacterId(cluster.characterName!);
    if (!characterId) {
      console.warn(
        `   ⚠ Skipped ${cluster.characterName}: no matching character in DB (check aliases)`,
      );
      continue;
    }
    const jpegBuffer = cluster.exemplar.jpegBuffer;

    try {
      await storeExemplar({
        jpegBuffer,
        characterId,
        bookId,
        sourceIssue,
        pageNumber: cluster.exemplar.pageNumber,
        confidence: cluster.confidence,
        isConfirmed: cluster.confidence >= 0.9,
      });
      seeded++;
      console.log(
        `   ✓ Seeded ${cluster.characterName} → ${characterId} (${(cluster.confidence * 100).toFixed(0)}%)`,
      );
    } catch (err) {
      console.warn(
        `   ⚠ Failed to seed ${cluster.characterName}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  console.log(`\n   Seeded ${seeded}/${qualifying.length} exemplars`);
  return seeded;
}

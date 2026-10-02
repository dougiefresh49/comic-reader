import type { SupabaseClient } from "@supabase/supabase-js";
import { embedImage } from "./embeddings";

const STORAGE_BUCKET = "face-exemplars";

export interface StoreExemplarParams {
  jpegBuffer: Buffer;
  characterId: string | null;
  suggestedName?: string;
  bookId: string;
  sourceIssue: string;
  pageNumber: number;
  confidence: number;
  isConfirmed: boolean;
  /** The `panel_character_detections` row this crop was cut from. */
  detectionId?: string;
  /** The crop's embedding when the caller already has it (`embedFace`). */
  embedding?: number[];
}

export interface ExemplarMatch {
  id: string;
  characterId: string;
  cropPath: string;
  confidence: number;
  similarity: number;
  compositeScore: number;
}

/** `embedImage` already tries the fallback key on a 429; name the service. */
export async function embedFace(jpegBase64: string): Promise<number[]> {
  try {
    return await embedImage(jpegBase64);
  } catch (err: unknown) {
    throw new Error(
      `Gemini embedding failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

/**
 * One exemplar per character (or suggested name) per page. A face with
 * neither is unnamed (#348): it matches only an exemplar cut from the same
 * detection, never another face's, so each unnamed crop gets its own row.
 */
export async function storeExemplar(
  supabase: SupabaseClient,
  params: StoreExemplarParams,
): Promise<string> {
  let query = supabase
    .from("character_face_exemplars")
    .select("id")
    .eq("book_id", params.bookId)
    .eq("source_issue", params.sourceIssue)
    .eq("page_number", params.pageNumber);

  let dedupe = true;
  if (params.characterId) {
    query = query.eq("character_id", params.characterId);
  } else if (params.suggestedName) {
    query = query.eq("suggested_name", params.suggestedName);
  } else if (params.detectionId) {
    query = query.eq("detection_id", params.detectionId);
  } else {
    dedupe = false;
  }

  if (dedupe) {
    const { data: existing, error: existingErr } = await query.limit(1);
    if (existingErr) {
      throw new Error(
        `character_face_exemplars read failed: ${existingErr.message}`,
      );
    }
    if (existing?.[0]) {
      return existing[0].id as string;
    }
  }

  const id = crypto.randomUUID();
  const folderName = params.characterId ?? "_unresolved";
  const storagePath = `${params.bookId}/${params.sourceIssue}/${folderName}/${id}.jpg`;

  const { error: uploadError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, params.jpegBuffer, {
      contentType: "image/jpeg",
      upsert: false,
    });

  if (uploadError) {
    throw new Error(`Storage upload failed: ${uploadError.message}`);
  }

  const embedding =
    params.embedding ?? (await embedFace(params.jpegBuffer.toString("base64")));
  const vectorString = `[${embedding.join(",")}]`;

  const row: Record<string, unknown> = {
    id,
    book_id: params.bookId,
    source_issue: params.sourceIssue,
    page_number: params.pageNumber,
    crop_path: storagePath,
    embedding: vectorString,
    confidence: params.confidence,
    is_confirmed: params.isConfirmed,
  };
  if (params.characterId) row.character_id = params.characterId;
  if (params.suggestedName) row.suggested_name = params.suggestedName;
  if (params.detectionId) row.detection_id = params.detectionId;

  const { error: insertError } = await supabase
    .from("character_face_exemplars")
    .insert(row);

  if (insertError) {
    throw new Error(`DB insert failed: ${insertError.message}`);
  }

  return id;
}

/** `face` is a JPEG as base64, or its embedding from `embedFace`. */
/** Deletes exemplar rows and their crops in Storage. Throws on any failure. */
export async function deleteExemplars(
  supabase: SupabaseClient,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const { data, error } = await supabase
    .from("character_face_exemplars")
    .delete()
    .in("id", ids)
    .select("crop_path");
  if (error) {
    throw new Error(`character_face_exemplars delete failed: ${error.message}`);
  }
  const paths = (data ?? []).map((r) => r.crop_path as string);
  if (paths.length === 0) return;
  const { error: removeErr } = await supabase.storage
    .from(STORAGE_BUCKET)
    .remove(paths);
  if (removeErr) {
    throw new Error(`${STORAGE_BUCKET} remove failed: ${removeErr.message}`);
  }
}

export async function findSimilarExemplars(
  supabase: SupabaseClient,
  face: string | number[],
  bookIds: string[],
  limit = 5,
): Promise<ExemplarMatch[]> {
  const embedding = typeof face === "string" ? await embedFace(face) : face;
  const vectorString = `[${embedding.join(",")}]`;

  const { data, error } = (await supabase.rpc("match_face_exemplars", {
    query_embedding: vectorString,
    book_ids: bookIds,
    match_limit: limit,
  })) as {
    data: Array<{
      id: string;
      character_id: string;
      crop_path: string;
      confidence: number;
      similarity: number;
      composite_score: number;
    }> | null;
    error: { message: string } | null;
  };

  if (error) {
    throw new Error(`match_face_exemplars rpc failed: ${error.message}`);
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    characterId: row.character_id,
    cropPath: row.crop_path,
    confidence: row.confidence,
    similarity: row.similarity,
    compositeScore: row.composite_score,
  }));
}

export async function downloadExemplarImage(
  supabase: SupabaseClient,
  cropPath: string,
): Promise<Buffer | null> {
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .download(cropPath);

  if (error) {
    throw new Error(
      `${STORAGE_BUCKET} download failed for ${cropPath}: ${error.message}`,
    );
  }
  if (!data) return null;

  return Buffer.from(await data.arrayBuffer());
}

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
}

export interface ExemplarMatch {
  id: string;
  characterId: string;
  cropPath: string;
  confidence: number;
  similarity: number;
  compositeScore: number;
}

export async function storeExemplar(
  supabase: SupabaseClient,
  params: StoreExemplarParams,
): Promise<string> {
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

  const embedding = await embedImage(params.jpegBuffer.toString("base64"));
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

  const { error: insertError } = await supabase
    .from("character_face_exemplars")
    .insert(row);

  if (insertError) {
    throw new Error(`DB insert failed: ${insertError.message}`);
  }

  return id;
}

export async function findSimilarExemplars(
  supabase: SupabaseClient,
  jpegBase64: string,
  bookIds: string[],
  limit = 5,
): Promise<ExemplarMatch[]> {
  const embedding = await embedImage(jpegBase64);
  const vectorString = `[${embedding.join(",")}]`;

  const { data, error } = await supabase.rpc("match_face_exemplars", {
    query_embedding: vectorString,
    book_ids: bookIds,
    match_limit: limit,
  });

  if (error) {
    console.warn(`   [exemplar] search failed: ${error.message}`);
    return [];
  }

  return (data ?? []).map(
    (row: {
      id: string;
      character_id: string;
      crop_path: string;
      confidence: number;
      similarity: number;
      composite_score: number;
    }) => ({
      id: row.id,
      characterId: row.character_id,
      cropPath: row.crop_path,
      confidence: row.confidence,
      similarity: row.similarity,
      compositeScore: row.composite_score,
    }),
  );
}

export async function downloadExemplarImage(
  supabase: SupabaseClient,
  cropPath: string,
): Promise<Buffer | null> {
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .download(cropPath);

  if (error || !data) {
    console.warn(
      `   [exemplar] download failed ${cropPath}: ${error?.message}`,
    );
    return null;
  }

  return Buffer.from(await data.arrayBuffer());
}

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding column to existing character_face_exemplars table
ALTER TABLE character_face_exemplars
  ADD COLUMN IF NOT EXISTS embedding vector(768);

-- HNSW index for fast cosine similarity (only confirmed exemplars with embeddings)
CREATE INDEX face_exemplars_embedding_idx
  ON character_face_exemplars
  USING hnsw (embedding vector_cosine_ops)
  WHERE is_confirmed = true;

-- RPC function for confidence-weighted similarity search
CREATE OR REPLACE FUNCTION match_face_exemplars(
  query_embedding vector(768),
  book_ids text[],
  match_limit int DEFAULT 5
)
RETURNS TABLE (
  id uuid,
  character_id text,
  crop_path text,
  confidence real,
  similarity float,
  composite_score float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    cfe.id,
    cfe.character_id,
    cfe.crop_path,
    cfe.confidence,
    (1 - (cfe.embedding <=> query_embedding))::float AS similarity,
    ((1 - (cfe.embedding <=> query_embedding)) * 0.7 + cfe.confidence * 0.3)::float AS composite_score
  FROM character_face_exemplars cfe
  WHERE cfe.is_confirmed = true
    AND cfe.book_id = ANY(book_ids)
    AND cfe.embedding IS NOT NULL
  ORDER BY composite_score DESC
  LIMIT match_limit;
$$;

GRANT EXECUTE ON FUNCTION match_face_exemplars TO service_role;

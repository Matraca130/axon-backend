-- ============================================================================
-- Migration: pgvector setup for RAG hybrid search
-- Date: 2026-03-05
-- Purpose: Add embedding column to chunks + hybrid search function
--
-- Prerequisites:
--   - Enable 'vector' extension in Supabase Dashboard > Database > Extensions
--   - Gemini text-embedding-004 outputs 768 dimensions
--
-- The hybrid search function combines:
--   - 70% semantic similarity (pgvector cosine distance)
--   - 30% full-text search (PostgreSQL ts_rank with Spanish config)
--
-- Institution scoping: joins through content hierarchy to courses.institution_id
--
-- LA-04 FIX: Changed from ivfflat to hnsw index (works with 0 initial rows)
-- LA-05 FIX: Uses CTE to compute cosine distance once per row
-- ============================================================================

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding column to chunks (768d = Gemini text-embedding-004)
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS
  embedding vector(768);

-- LA-04 FIX: Use hnsw instead of ivfflat.
-- hnsw works correctly with 0 initial rows (ivfflat needs data to build centroids).
-- hnsw is also faster for queries (slightly slower inserts, which is fine for batch ingest).
CREATE INDEX IF NOT EXISTS idx_chunks_embedding
  ON chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- LA-05 FIX: Hybrid search with CTE to compute cosine distance ONCE per row.
-- Previously the expression (1 - (ch.embedding <=> p_query_embedding)) was
-- evaluated 3 times: in SELECT similarity, in combined_score, and in WHERE.
CREATE OR REPLACE FUNCTION rag_hybrid_search(
  p_query_embedding vector(768),
  p_query_text TEXT,
  p_institution_id UUID,
  p_summary_id UUID DEFAULT NULL,
  p_match_count INT DEFAULT 5,
  p_similarity_threshold FLOAT DEFAULT 0.3
)
RETURNS TABLE (
  chunk_id UUID,
  summary_id UUID,
  summary_title TEXT,
  content TEXT,
  similarity FLOAT,
  text_rank FLOAT,
  combined_score FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  WITH scored AS (
    SELECT
      ch.id,
      s.id AS s_id,
      s.title AS s_title,
      ch.content AS c_content,
      -- Compute cosine similarity ONCE
      (1 - (ch.embedding <=> p_query_embedding))::FLOAT AS sim,
      -- Compute full-text rank ONCE
      ts_rank(
        to_tsvector('spanish', ch.content),
        plainto_tsquery('spanish', p_query_text)
      )::FLOAT AS trank
    FROM chunks ch
    JOIN summaries s ON s.id = ch.summary_id
    JOIN topics t ON t.id = s.topic_id
    JOIN sections sec ON sec.id = t.section_id
    JOIN semesters sem ON sem.id = sec.semester_id
    JOIN courses c ON c.id = sem.course_id
    WHERE ch.embedding IS NOT NULL
      AND c.institution_id = p_institution_id
      AND s.deleted_at IS NULL AND s.is_active = TRUE
      AND t.deleted_at IS NULL AND t.is_active = TRUE
      AND sec.deleted_at IS NULL AND sec.is_active = TRUE
      AND sem.deleted_at IS NULL AND sem.is_active = TRUE
      AND c.deleted_at IS NULL AND c.is_active = TRUE
      AND (p_summary_id IS NULL OR s.id = p_summary_id)
  )
  SELECT
    scored.id AS chunk_id,
    scored.s_id AS summary_id,
    scored.s_title AS summary_title,
    scored.c_content AS content,
    scored.sim AS similarity,
    scored.trank AS text_rank,
    (0.7 * scored.sim + 0.3 * scored.trank)::FLOAT AS combined_score
  FROM scored
  WHERE scored.sim > p_similarity_threshold
  ORDER BY (0.7 * scored.sim + 0.3 * scored.trank) DESC
  LIMIT p_match_count;
END;
$$;

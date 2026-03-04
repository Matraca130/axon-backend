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
-- ============================================================================

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding column to chunks (768d = Gemini text-embedding-004)
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS
  embedding vector(768);

-- Index for cosine similarity search
-- ivfflat is better than hnsw for < 100K rows
-- lists = sqrt(num_rows), adjust if you have > 10K chunks
CREATE INDEX IF NOT EXISTS idx_chunks_embedding
  ON chunks USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 50);

-- Hybrid search function: embedding similarity + full-text
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
  SELECT
    ch.id AS chunk_id,
    s.id AS summary_id,
    s.title AS summary_title,
    ch.content,
    (1 - (ch.embedding <=> p_query_embedding))::FLOAT AS similarity,
    ts_rank(
      to_tsvector('spanish', ch.content),
      plainto_tsquery('spanish', p_query_text)
    )::FLOAT AS text_rank,
    -- Combined: 70% semantic + 30% full-text
    (
      0.7 * (1 - (ch.embedding <=> p_query_embedding)) +
      0.3 * ts_rank(
        to_tsvector('spanish', ch.content),
        plainto_tsquery('spanish', p_query_text)
      )
    )::FLOAT AS combined_score
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
    AND (1 - (ch.embedding <=> p_query_embedding)) > p_similarity_threshold
  ORDER BY combined_score DESC
  LIMIT p_match_count;
END;
$$;

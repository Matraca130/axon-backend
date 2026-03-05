-- ============================================================
-- Migration: T-02 — Generated tsvector columns + GIN indexes
-- Date: 2026-03-06
-- Phase: 2 (RAG Roadmap)
--
-- Purpose:
--   Pre-compute tsvector for FTS instead of inline to_tsvector()
--   on every query. Adds GENERATED ALWAYS AS ... STORED columns
--   with GIN indexes for fast full-text search.
--
-- Performance:
--   Before: to_tsvector('spanish', ch.content) computed per-row per-query
--   After:  ch.fts is pre-computed on INSERT/UPDATE, indexed with GIN
--
-- Safety:
--   All operations use IF NOT EXISTS / CREATE OR REPLACE.
--   Fully idempotent — safe to re-run.
-- ============================================================

-- 1. chunks.fts — pre-computed tsvector of content
ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (to_tsvector('spanish', coalesce(content, ''))) STORED;

CREATE INDEX IF NOT EXISTS idx_chunks_fts ON chunks USING gin (fts);

-- 2. summaries.fts — pre-computed tsvector of title + content_markdown
ALTER TABLE summaries
  ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (
    to_tsvector('spanish', coalesce(title, '') || ' ' || coalesce(content_markdown, ''))
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_summaries_fts ON summaries USING gin (fts);

-- 3. Update rag_hybrid_search to use pre-computed fts column
--    Change: ts_rank(to_tsvector('spanish', ch.content), ...) → ts_rank(ch.fts, ...)
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
      (1 - (ch.embedding <=> p_query_embedding))::FLOAT AS sim,
      ts_rank(
        ch.fts,  -- ← uses pre-computed STORED column instead of inline to_tsvector()
        plainto_tsquery('spanish', p_query_text)
      )::FLOAT AS trank
    FROM chunks ch
    JOIN summaries s ON s.id = ch.summary_id
    WHERE ch.embedding IS NOT NULL
      AND s.institution_id = p_institution_id
      AND s.deleted_at IS NULL AND s.is_active = TRUE
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

COMMENT ON FUNCTION rag_hybrid_search IS
  'T-02: Hybrid vector+FTS search using pre-computed tsvector columns. Uses s.institution_id (denormalized, T-01) and ch.fts (generated stored, T-02).';

-- ============================================================
-- Migration: Fase 2 — Stored tsvector columns + GIN + RPC v3
-- Date: 2026-03-06
-- RAG Roadmap: Fase 2
--
-- Problem: rag_hybrid_search() computes to_tsvector('spanish', ch.content)
--   INLINE for every row on every query. This is pure CPU waste because
--   the content rarely changes after ingestion.
--
-- Solution:
--   1. Add GENERATED ALWAYS AS stored tsvector columns to chunks + summaries
--   2. Create GIN indexes on both (enables pre-filtering)
--   3. Update RPC to use ch.fts instead of to_tsvector() inline
--
-- Impact: Eliminates per-row tsvector computation.
--   Combined with Fase 1 (denormalized institution_id), the RPC now:
--   - 1 JOIN (chunks → summaries) instead of 6
--   - 0 inline tsvector() calls (uses stored column)
--   - GIN index enables index-only scans for FTS filtering
--
-- Prerequisites: Fase 1 migration 20260304_06 must be applied first.
-- ============================================================

-- 1. Stored tsvector column on chunks
ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (to_tsvector('spanish', coalesce(content, ''))) STORED;

-- 2. GIN index for fast FTS queries on chunks
CREATE INDEX IF NOT EXISTS idx_chunks_fts
  ON chunks USING gin (fts);

-- 3. Stored tsvector column on summaries (title + content)
ALTER TABLE summaries
  ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (
    to_tsvector('spanish', coalesce(title, '') || ' ' || coalesce(content_markdown, ''))
  ) STORED;

-- 4. GIN index for fast FTS queries on summaries
CREATE INDEX IF NOT EXISTS idx_summaries_fts
  ON summaries USING gin (fts);

-- 5. Update rag_hybrid_search() v3:
--    - Uses denormalized institution_id (Fase 1)
--    - Uses stored fts column (Fase 2) instead of inline to_tsvector()
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
      -- Compute cosine similarity ONCE (LA-05)
      (1 - (ch.embedding <=> p_query_embedding))::FLOAT AS sim,
      -- Fase 2 FIX: Use stored fts column instead of inline to_tsvector()
      ts_rank(
        ch.fts,
        plainto_tsquery('spanish', p_query_text)
      )::FLOAT AS trank
    FROM chunks ch
    -- Fase 1 FIX: Only 1 JOIN (institution_id denormalized on summaries)
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

-- 6. Add comment for future agents
COMMENT ON FUNCTION rag_hybrid_search IS
  'RAG hybrid search v3. Uses denormalized institution_id (Fase 1) + stored fts column (Fase 2). '
  'Signature is backwards-compatible with v1/v2. '
  'If embedding dimensions change, update p_query_embedding vector(768) parameter.';

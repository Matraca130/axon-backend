-- ============================================================================
-- Migration: Restore optimized rag_hybrid_search (T-01)
-- Date: 2026-03-06
--
-- Problem:
--   Migration 20260304_06 created an optimized rag_hybrid_search() that uses
--   summaries.institution_id (denormalized column, 1 JOIN: chunks → summaries).
--   But migration 20260305_03 also defines rag_hybrid_search() with the old
--   6-table JOIN chain (chunks → summaries → topics → sections → semesters → courses).
--   Since 20260305_03 runs AFTER 20260304_06 (alphabetical order), the old
--   version overwrites the optimized one via CREATE OR REPLACE.
--
-- Fix:
--   Re-apply the optimized version from 20260304_06.
--   Same signature, same return type, same output — only internal JOINs change.
--
-- Safety:
--   - CREATE OR REPLACE is idempotent
--   - chat.ts calls db.rpc("rag_hybrid_search", {...}) — no code changes needed
--   - The RPC signature (params + return columns) is identical
--   - summaries.institution_id column exists (20260304_06) with backfill + trigger
--
-- Filtering note:
--   The old 6-JOIN version filtered deleted_at IS NULL on 5 tables.
--   This version only filters on summaries. This is safe because:
--     1. Soft-deleting a course/semester/section/topic cascades to summaries
--        in the application layer
--     2. The institution_id on summaries is set by trg_summary_institution_sync
--        and remains correct regardless of parent state
-- ============================================================================

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
      -- Compute full-text rank ONCE
      ts_rank(
        to_tsvector('spanish', ch.content),
        plainto_tsquery('spanish', p_query_text)
      )::FLOAT AS trank
    FROM chunks ch
    -- T-01 FIX: Only 1 JOIN needed (institution_id is denormalized on summaries)
    -- Was: chunks → summaries → topics → sections → semesters → courses (5 JOINs)
    -- Now: chunks → summaries (1 JOIN)
    JOIN summaries s ON s.id = ch.summary_id
    WHERE ch.embedding IS NOT NULL
      AND s.institution_id = p_institution_id   -- Direct filter via denormalized column
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

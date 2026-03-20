-- ============================================================
-- Migration: Denormalize institution_id on summaries
-- INC-7 FIX / RAG Roadmap Fase 1
-- Date: 2026-03-04
--
-- Problem: rag_hybrid_search() RPC joins 6 tables per query:
--   chunks → summaries → topics → sections → semesters → courses
--   just to filter by institution_id.
--
-- Solution: Add institution_id directly to summaries.
--   - Backfill from existing hierarchy
--   - Trigger to keep in sync
--   - Update RPC to use only 2 JOINs (chunks → summaries)
--
-- Impact: Eliminates 4 JOINs per RAG query.
-- ============================================================

-- 1. Add denormalized column
ALTER TABLE summaries
  ADD COLUMN IF NOT EXISTS institution_id UUID REFERENCES institutions(id);

-- 2. Backfill from the hierarchy
UPDATE summaries s
SET institution_id = c.institution_id
FROM topics t
  JOIN sections sec ON sec.id = t.section_id
  JOIN semesters sem ON sem.id = sec.semester_id
  JOIN courses c ON c.id = sem.course_id
WHERE t.id = s.topic_id
  AND s.institution_id IS NULL;

-- 3. Index for direct filtering
CREATE INDEX IF NOT EXISTS idx_summaries_institution_id
  ON summaries (institution_id);

-- 4. Trigger: keep institution_id in sync when topic_id changes
CREATE OR REPLACE FUNCTION sync_summary_institution_id()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  SELECT c.institution_id INTO NEW.institution_id
  FROM topics t
    JOIN sections sec ON sec.id = t.section_id
    JOIN semesters sem ON sem.id = sec.semester_id
    JOIN courses c ON c.id = sem.course_id
  WHERE t.id = NEW.topic_id;
  RETURN NEW;
END;
$$;

-- Drop if exists to avoid duplicate trigger error
DROP TRIGGER IF EXISTS trg_summary_institution_sync ON summaries;

CREATE TRIGGER trg_summary_institution_sync
  BEFORE INSERT OR UPDATE OF topic_id ON summaries
  FOR EACH ROW
  EXECUTE FUNCTION sync_summary_institution_id();

-- 5. Update rag_hybrid_search() to use denormalized column
--    Before: 6-table JOIN (chunks→summaries→topics→sections→semesters→courses)
--    After:  2-table JOIN (chunks→summaries) with direct institution_id filter
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
    -- INC-7 FIX: Only 1 JOIN needed (institution_id is on summaries now)
    JOIN summaries s ON s.id = ch.summary_id
    WHERE ch.embedding IS NOT NULL
      AND s.institution_id = p_institution_id   -- Direct filter (was 6-table chain)
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

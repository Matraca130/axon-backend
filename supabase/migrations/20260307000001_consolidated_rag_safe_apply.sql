-- ============================================================================
-- CONSOLIDATED RAG MIGRATION — Safe Apply
-- Date: 2026-03-07
-- Purpose: Apply ALL RAG prerequisites (Phases 1-4) in one idempotent script
--
-- This consolidates and resolves conflicts between:
--   20260304_06 (Phase 1: denorm institution_id)
--   20260305_03 (pgvector + old 6-JOIN RPC — overwrites Phase 1!)
--   20260306_02 (Phase 2: fts columns + RPC v3)
--   20260306_02_restore (fixes 20260305_03 overwrite)
--   20260306_03 (duplicate of 20260306_02)
--
-- The conflict: 20260305_03 defines rag_hybrid_search with 6 JOINs.
-- 20260304_06 defines it with 1 JOIN. Since 20260305_03 runs AFTER
-- 20260304_06 alphabetically, it OVERWRITES the optimized version.
-- This migration applies the FINAL correct version (v3: 1 JOIN + stored fts).
--
-- SAFETY:
--   - Every statement uses IF NOT EXISTS or CREATE OR REPLACE
--   - Safe to run multiple times
--   - Safe to run even if some parts are already applied
--   - Includes verification queries at the end
--
-- HOW TO USE:
--   1. Open Supabase Dashboard → SQL Editor
--   2. Paste this ENTIRE file
--   3. Click "Run"
--   4. Check the RAISE NOTICE messages at the bottom for verification
-- ============================================================================

-- ════════════════════════════════════════════════════════════════════
-- PREREQUISITE: pgvector extension
-- ════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS vector;

-- ════════════════════════════════════════════════════════════════════
-- PHASE 1: Denormalize institution_id on summaries
-- ════════════════════════════════════════════════════════════════════

-- 1a. Add column
ALTER TABLE summaries
  ADD COLUMN IF NOT EXISTS institution_id UUID REFERENCES institutions(id);

-- 1b. Backfill from hierarchy (only rows where institution_id is NULL)
UPDATE summaries s
SET institution_id = c.institution_id
FROM topics t
  JOIN sections sec ON sec.id = t.section_id
  JOIN semesters sem ON sem.id = sec.semester_id
  JOIN courses c ON c.id = sem.course_id
WHERE t.id = s.topic_id
  AND s.institution_id IS NULL;

-- 1c. Index for direct filtering
CREATE INDEX IF NOT EXISTS idx_summaries_institution_id
  ON summaries (institution_id);

-- 1d. Trigger to keep institution_id in sync
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

DROP TRIGGER IF EXISTS trg_summary_institution_sync ON summaries;
CREATE TRIGGER trg_summary_institution_sync
  BEFORE INSERT OR UPDATE OF topic_id ON summaries
  FOR EACH ROW
  EXECUTE FUNCTION sync_summary_institution_id();

-- ════════════════════════════════════════════════════════════════════
-- PGVECTOR: Embedding column + HNSW index on chunks
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE chunks ADD COLUMN IF NOT EXISTS
  embedding vector(768);

CREATE INDEX IF NOT EXISTS idx_chunks_embedding
  ON chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ════════════════════════════════════════════════════════════════════
-- PHASE 2: Stored tsvector columns + GIN indexes
-- ════════════════════════════════════════════════════════════════════

-- 2a. chunks.fts — pre-computed tsvector of content
ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (to_tsvector('spanish', coalesce(content, ''))) STORED;

CREATE INDEX IF NOT EXISTS idx_chunks_fts
  ON chunks USING gin (fts);

-- 2b. summaries.fts — pre-computed tsvector of title + content_markdown
ALTER TABLE summaries
  ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (
    to_tsvector('spanish', coalesce(title, '') || ' ' || coalesce(content_markdown, ''))
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_summaries_fts
  ON summaries USING gin (fts);

-- ════════════════════════════════════════════════════════════════════
-- RAG HYBRID SEARCH v3 (FINAL — resolves all conflicts)
--
-- Uses:
--   - s.institution_id (Phase 1 denorm) → 1 JOIN instead of 6
--   - ch.fts (Phase 2 stored column) → 0 inline tsvector() calls
-- ════════════════════════════════════════════════════════════════════

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
        ch.fts,
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
  'RAG hybrid search v3 (consolidated 2026-03-07). '
  'Uses denormalized institution_id (Phase 1) + stored fts column (Phase 2). '
  'Signature backwards-compatible with v1/v2.';

-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION: Check that everything was applied correctly
-- ════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_has_inst_id BOOLEAN;
  v_has_fts_chunks BOOLEAN;
  v_has_fts_summaries BOOLEAN;
  v_has_embedding BOOLEAN;
  v_backfill_null INT;
  v_rpc_exists BOOLEAN;
BEGIN
  -- Check summaries.institution_id exists
  SELECT EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'summaries' AND column_name = 'institution_id'
  ) INTO v_has_inst_id;

  -- Check chunks.fts exists
  SELECT EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chunks' AND column_name = 'fts'
  ) INTO v_has_fts_chunks;

  -- Check summaries.fts exists
  SELECT EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'summaries' AND column_name = 'fts'
  ) INTO v_has_fts_summaries;

  -- Check chunks.embedding exists
  SELECT EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chunks' AND column_name = 'embedding'
  ) INTO v_has_embedding;

  -- Check backfill completeness
  SELECT count(*) INTO v_backfill_null
  FROM summaries WHERE institution_id IS NULL AND topic_id IS NOT NULL;

  -- Check RPC exists
  SELECT EXISTS(
    SELECT 1 FROM pg_proc WHERE proname = 'rag_hybrid_search'
  ) INTO v_rpc_exists;

  RAISE NOTICE '══════════════════════════════════════════════';
  RAISE NOTICE '  RAG MIGRATION VERIFICATION RESULTS';
  RAISE NOTICE '══════════════════════════════════════════════';
  RAISE NOTICE '  summaries.institution_id: %', CASE WHEN v_has_inst_id THEN 'OK' ELSE 'MISSING!' END;
  RAISE NOTICE '  chunks.embedding:         %', CASE WHEN v_has_embedding THEN 'OK' ELSE 'MISSING!' END;
  RAISE NOTICE '  chunks.fts:               %', CASE WHEN v_has_fts_chunks THEN 'OK' ELSE 'MISSING!' END;
  RAISE NOTICE '  summaries.fts:            %', CASE WHEN v_has_fts_summaries THEN 'OK' ELSE 'MISSING!' END;
  RAISE NOTICE '  rag_hybrid_search RPC:    %', CASE WHEN v_rpc_exists THEN 'OK' ELSE 'MISSING!' END;
  RAISE NOTICE '  Backfill NULL count:      % (should be 0)', v_backfill_null;
  RAISE NOTICE '══════════════════════════════════════════════';

  IF NOT v_has_inst_id OR NOT v_has_fts_chunks OR NOT v_has_fts_summaries
     OR NOT v_has_embedding OR NOT v_rpc_exists THEN
    RAISE WARNING 'Some components are missing! Check the notices above.';
  ELSE
    RAISE NOTICE '  ALL CHECKS PASSED — RAG pipeline is ready.';
  END IF;
END;
$$;

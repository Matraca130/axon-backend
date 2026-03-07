-- ============================================================================
-- Migration: Embedding dimension upgrade 768d → 1536d
-- Date: 2026-03-11
-- Purpose: Migrate from Gemini embedding-001 (768d) to
--          OpenAI text-embedding-3-large truncated to 1536d
--
-- Decisions: D57, D58
--
-- IMPORTANT: After running this migration, you MUST:
--   1. Set OPENAI_API_KEY secret: supabase secrets set OPENAI_API_KEY=sk-...
--   2. Deploy the updated Edge Functions
--   3. Run the re-embed route: POST /ai/re-embed-all
--   4. Run 20260311_02_recreate_hnsw_indexes.sql AFTER re-embed completes
--
-- This migration is DESTRUCTIVE for existing embeddings.
-- All existing embeddings are nullified because 768d vectors are
-- incompatible with 1536d columns.
-- ============================================================================

-- ════════════════════════════════════════════════════════════════════
-- Step 1: Drop HNSW indexes (cannot ALTER type with index present)
-- ════════════════════════════════════════════════════════════════════

DROP INDEX IF EXISTS idx_chunks_embedding;
DROP INDEX IF EXISTS idx_chunks_embedding_hnsw;
DROP INDEX IF EXISTS idx_summaries_embedding_hnsw;

-- ════════════════════════════════════════════════════════════════════
-- Step 2: Nullify existing embeddings (768d incompatible with 1536d)
-- ════════════════════════════════════════════════════════════════════

UPDATE chunks SET embedding = NULL WHERE embedding IS NOT NULL;
UPDATE summaries SET embedding = NULL WHERE embedding IS NOT NULL;

-- ════════════════════════════════════════════════════════════════════
-- Step 3: ALTER columns from vector(768) to vector(1536)
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE chunks
  ALTER COLUMN embedding TYPE vector(1536);

ALTER TABLE summaries
  ALTER COLUMN embedding TYPE vector(1536);

-- ════════════════════════════════════════════════════════════════════
-- Step 4: Update rag_hybrid_search() — vector(768) → vector(1536)
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION rag_hybrid_search(
  p_query_embedding vector(1536),
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

COMMENT ON FUNCTION rag_hybrid_search IS 'RAG hybrid search v4 (D57: OpenAI 1536d). Uses denormalized institution_id + stored fts.';

-- ════════════════════════════════════════════════════════════════════
-- Step 5: Update rag_coarse_to_fine_search() — vector(768) → vector(1536)
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION rag_coarse_to_fine_search(
  p_query_embedding   vector(1536),
  p_institution_id    UUID,
  p_top_summaries     INT   DEFAULT 3,
  p_top_chunks        INT   DEFAULT 5,
  p_similarity_threshold FLOAT DEFAULT 0.3
)
RETURNS TABLE (
  chunk_id            UUID,
  summary_id          UUID,
  summary_title       TEXT,
  content             TEXT,
  summary_similarity  FLOAT,
  chunk_similarity    FLOAT,
  combined_score      FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  WITH summary_scored AS (
    SELECT
      s.id,
      s.title,
      (1 - (s.embedding <=> p_query_embedding))::FLOAT AS sim
    FROM summaries s
    WHERE s.embedding IS NOT NULL
      AND s.institution_id = p_institution_id
      AND s.deleted_at IS NULL
      AND s.is_active = TRUE
  ),
  top_summaries AS (
    SELECT ss.id, ss.title, ss.sim
    FROM summary_scored ss
    WHERE ss.sim > p_similarity_threshold
    ORDER BY ss.sim DESC
    LIMIT p_top_summaries
  ),
  scored_chunks AS (
    SELECT
      ch.id          AS c_id,
      ts.id          AS s_id,
      ts.title       AS s_title,
      ch.content     AS c_content,
      ts.sim         AS s_sim,
      (1 - (ch.embedding <=> p_query_embedding))::FLOAT AS c_sim
    FROM top_summaries ts
    JOIN chunks ch ON ch.summary_id = ts.id
    WHERE ch.embedding IS NOT NULL
  )
  SELECT
    sc.c_id              AS chunk_id,
    sc.s_id              AS summary_id,
    sc.s_title           AS summary_title,
    sc.c_content         AS content,
    sc.s_sim             AS summary_similarity,
    sc.c_sim             AS chunk_similarity,
    (0.3 * sc.s_sim + 0.7 * sc.c_sim)::FLOAT AS combined_score
  FROM scored_chunks sc
  ORDER BY (0.3 * sc.s_sim + 0.7 * sc.c_sim) DESC
  LIMIT p_top_chunks;
END;
$$;

COMMENT ON FUNCTION rag_coarse_to_fine_search IS 'Coarse-to-fine RAG v2 (D57: OpenAI 1536d). Score = 0.3 x summary + 0.7 x chunk.';

-- ════════════════════════════════════════════════════════════════════
-- Step 6: Update column comment
-- ════════════════════════════════════════════════════════════════════

COMMENT ON COLUMN summaries.embedding IS 'Summary embedding (1536d, OpenAI text-embedding-3-large). D57 migration.';

-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_chunks_type TEXT;
  v_summaries_type TEXT;
  v_hybrid_exists BOOLEAN;
  v_c2f_exists BOOLEAN;
  v_null_chunks INT;
  v_null_summaries INT;
BEGIN
  SELECT udt_name || '(' || character_maximum_length || ')'
  INTO v_chunks_type
  FROM information_schema.columns
  WHERE table_name = 'chunks' AND column_name = 'embedding';

  SELECT udt_name || '(' || character_maximum_length || ')'
  INTO v_summaries_type
  FROM information_schema.columns
  WHERE table_name = 'summaries' AND column_name = 'embedding';

  SELECT EXISTS(SELECT 1 FROM pg_proc WHERE proname = 'rag_hybrid_search') INTO v_hybrid_exists;
  SELECT EXISTS(SELECT 1 FROM pg_proc WHERE proname = 'rag_coarse_to_fine_search') INTO v_c2f_exists;

  SELECT count(*) INTO v_null_chunks FROM chunks WHERE embedding IS NOT NULL;
  SELECT count(*) INTO v_null_summaries FROM summaries WHERE embedding IS NOT NULL;

  RAISE NOTICE '══════════════════════════════════════════════════';
  RAISE NOTICE '  D57 EMBEDDING MIGRATION VERIFICATION';
  RAISE NOTICE '══════════════════════════════════════════════════';
  RAISE NOTICE '  chunks.embedding type:        %', v_chunks_type;
  RAISE NOTICE '  summaries.embedding type:     %', v_summaries_type;
  RAISE NOTICE '  rag_hybrid_search:            %', CASE WHEN v_hybrid_exists THEN 'OK' ELSE 'MISSING!' END;
  RAISE NOTICE '  rag_coarse_to_fine_search:    %', CASE WHEN v_c2f_exists THEN 'OK' ELSE 'MISSING!' END;
  RAISE NOTICE '  Non-null chunk embeddings:    % (should be 0)', v_null_chunks;
  RAISE NOTICE '  Non-null summary embeddings:  % (should be 0)', v_null_summaries;
  RAISE NOTICE '══════════════════════════════════════════════════';
  RAISE NOTICE '  NEXT: Deploy functions, set OPENAI_API_KEY, run re-embed, then recreate indexes.';
END;
$$;

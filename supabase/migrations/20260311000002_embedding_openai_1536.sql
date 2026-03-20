-- ============================================================================
-- Migration: Embeddings Gemini 768d -> OpenAI text-embedding-3-large 1536d
-- Date: 2026-03-11
-- Decisions: D57 (model), D58 (in-place), D60 (centralized config)
--
-- What this does:
--   1. Drop HNSW indexes (cannot ALTER vector dimension in-place)
--   2. NULL existing 768d embeddings (incompatible with new dimensions)
--   3. ALTER chunks.embedding from vector(768) to vector(1536)
--   4. ADD summaries.embedding as vector(1536) (Fase 3 migration was not applied)
--   5. Recreate rag_hybrid_search with vector(1536) parameter
--   6. Recreate rag_coarse_to_fine_search with vector(1536) parameter
--   7. Recreate HNSW indexes
--   8. Verification block
--
-- IMPORTANT: After running this migration, existing chunks and summaries
-- will have NULL embeddings. Re-embed via:
--   POST /ai/ingest-embeddings { institution_id, target: "chunks" }
--   POST /ai/ingest-embeddings { institution_id, target: "summaries" }
-- Or let the auto-ingest pipeline handle new/updated summaries.
--
-- Prerequisites:
--   supabase secrets set OPENAI_API_KEY=sk-...
-- ============================================================================

-- ════════════════════════════════════════════════════════════════════
-- 1. Drop HNSW indexes (safe: IF EXISTS)
-- ════════════════════════════════════════════════════════════════════

DROP INDEX IF EXISTS idx_chunks_embedding;
DROP INDEX IF EXISTS idx_summaries_embedding_hnsw;

-- ════════════════════════════════════════════════════════════════════
-- 2. NULL existing embeddings in chunks (768d incompatible with 1536d)
-- ════════════════════════════════════════════════════════════════════

UPDATE chunks SET embedding = NULL WHERE embedding IS NOT NULL;

-- ════════════════════════════════════════════════════════════════════
-- 3. ALTER chunks.embedding to vector(1536)
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE chunks
  ALTER COLUMN embedding TYPE vector(1536);

-- ════════════════════════════════════════════════════════════════════
-- 4. ADD summaries.embedding as vector(1536)
--    (Fase 3 migration 20260307_03 was never applied to the DB,
--     so this column does not exist yet. We create it directly
--     at the target dimension to avoid a double migration.)
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE summaries
  ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- ════════════════════════════════════════════════════════════════════
-- 5. Recreate rag_hybrid_search with vector(1536)
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

COMMENT ON FUNCTION rag_hybrid_search IS 'RAG hybrid search v4 (D57: OpenAI 1536d).';

-- ════════════════════════════════════════════════════════════════════
-- 6. Recreate rag_coarse_to_fine_search with vector(1536)
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

COMMENT ON FUNCTION rag_coarse_to_fine_search IS 'Two-stage RAG search v2 (D57: OpenAI 1536d).';

-- ════════════════════════════════════════════════════════════════════
-- 7. Recreate HNSW indexes
-- ════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_chunks_embedding
  ON chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_summaries_embedding_hnsw
  ON summaries USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE embedding IS NOT NULL;

-- ════════════════════════════════════════════════════════════════════
-- 8. Verification
-- ════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_chunk_type TEXT;
  v_summary_type TEXT;
  v_has_chunk_idx BOOLEAN;
  v_has_summary_idx BOOLEAN;
  v_rpc_hybrid BOOLEAN;
  v_rpc_c2f BOOLEAN;
  v_nonnull_chunks INT;
  v_nonnull_summaries INT;
BEGIN
  SELECT data_type INTO v_chunk_type
  FROM information_schema.columns
  WHERE table_name = 'chunks' AND column_name = 'embedding';

  SELECT data_type INTO v_summary_type
  FROM information_schema.columns
  WHERE table_name = 'summaries' AND column_name = 'embedding';

  SELECT EXISTS(SELECT 1 FROM pg_indexes WHERE indexname = 'idx_chunks_embedding')
  INTO v_has_chunk_idx;

  SELECT EXISTS(SELECT 1 FROM pg_indexes WHERE indexname = 'idx_summaries_embedding_hnsw')
  INTO v_has_summary_idx;

  SELECT EXISTS(SELECT 1 FROM pg_proc WHERE proname = 'rag_hybrid_search')
  INTO v_rpc_hybrid;

  SELECT EXISTS(SELECT 1 FROM pg_proc WHERE proname = 'rag_coarse_to_fine_search')
  INTO v_rpc_c2f;

  SELECT count(*) INTO v_nonnull_chunks FROM chunks WHERE embedding IS NOT NULL;
  SELECT count(*) INTO v_nonnull_summaries FROM summaries WHERE embedding IS NOT NULL;

  RAISE NOTICE '';
  RAISE NOTICE '  D57 MIGRATION COMPLETE';
  RAISE NOTICE '  chunks.embedding:             % (expect USER-DEFINED)', v_chunk_type;
  RAISE NOTICE '  summaries.embedding:          % (expect USER-DEFINED)', v_summary_type;
  RAISE NOTICE '  idx_chunks_embedding:         %', CASE WHEN v_has_chunk_idx THEN 'OK' ELSE 'MISSING' END;
  RAISE NOTICE '  idx_summaries_embedding_hnsw: %', CASE WHEN v_has_summary_idx THEN 'OK' ELSE 'MISSING' END;
  RAISE NOTICE '  rag_hybrid_search:            %', CASE WHEN v_rpc_hybrid THEN 'OK' ELSE 'MISSING' END;
  RAISE NOTICE '  rag_coarse_to_fine_search:    %', CASE WHEN v_rpc_c2f THEN 'OK' ELSE 'MISSING' END;
  RAISE NOTICE '  Non-null chunk embeddings:    % (expect 0)', v_nonnull_chunks;
  RAISE NOTICE '  Non-null summary embeddings:  % (expect 0)', v_nonnull_summaries;
  RAISE NOTICE '';
END;
$$;

-- ============================================================================
-- Post-migration: Recreate HNSW indexes after re-embed
-- Date: 2026-03-11
--
-- RUN THIS ONLY AFTER re-embed-all has completed successfully
-- and all chunks/summaries have 1536d embeddings.
--
-- Verification: Before running, confirm:
--   SELECT count(*) FROM chunks WHERE embedding IS NULL;     -- should be 0
--   SELECT count(*) FROM summaries WHERE embedding IS NULL;  -- should be 0 (or only empty summaries)
-- ============================================================================

-- Chunks HNSW index
CREATE INDEX IF NOT EXISTS idx_chunks_embedding_hnsw
  ON chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Summaries HNSW index (partial: only non-null embeddings)
CREATE INDEX IF NOT EXISTS idx_summaries_embedding_hnsw
  ON summaries USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE embedding IS NOT NULL;

-- Verification
DO $$
DECLARE
  v_chunks_idx BOOLEAN;
  v_summaries_idx BOOLEAN;
BEGIN
  SELECT EXISTS(SELECT 1 FROM pg_indexes WHERE indexname = 'idx_chunks_embedding_hnsw') INTO v_chunks_idx;
  SELECT EXISTS(SELECT 1 FROM pg_indexes WHERE indexname = 'idx_summaries_embedding_hnsw') INTO v_summaries_idx;

  RAISE NOTICE '══════════════════════════════════════════════════';
  RAISE NOTICE '  HNSW INDEX RECREATION VERIFICATION';
  RAISE NOTICE '══════════════════════════════════════════════════';
  RAISE NOTICE '  idx_chunks_embedding_hnsw:    %', CASE WHEN v_chunks_idx THEN 'OK' ELSE 'MISSING!' END;
  RAISE NOTICE '  idx_summaries_embedding_hnsw: %', CASE WHEN v_summaries_idx THEN 'OK' ELSE 'MISSING!' END;
  RAISE NOTICE '══════════════════════════════════════════════════';
END;
$$;

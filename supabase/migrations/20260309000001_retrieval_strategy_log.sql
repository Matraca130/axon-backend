-- =============================================================
-- Fase 6: Add retrieval strategy observability to rag_query_log
-- =============================================================
--
-- Additive-only migration. Backward compatible:
--   - DEFAULT values match pre-Fase 6 behavior
--   - No backfill needed
--   - Existing INSERT statements (without these columns) work unchanged
--
-- D26: Separate columns for strategy and search_type
--   search_type       = search method (hybrid | coarse_to_fine | hybrid_fallback)
--   retrieval_strategy = Fase 6 strategy (standard | multi_query | hyde)
--   rerank_applied     = whether Gemini re-ranking was applied post-search

ALTER TABLE rag_query_log
  ADD COLUMN IF NOT EXISTS retrieval_strategy TEXT NOT NULL DEFAULT 'standard';

ALTER TABLE rag_query_log
  ADD COLUMN IF NOT EXISTS rerank_applied BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN rag_query_log.retrieval_strategy
  IS 'Fase 6: standard | multi_query | hyde — which retrieval strategy was used';

COMMENT ON COLUMN rag_query_log.rerank_applied
  IS 'Fase 6: whether Gemini re-ranking was applied as post-processor';

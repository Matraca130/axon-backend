-- ============================================================================
-- Migration: Summary-level embeddings + Coarse-to-Fine search RPC
-- Date: 2026-03-07
-- Purpose: Enable two-level RAG search (summary → chunks)
--
-- Fase 3 — Bloque 2 del plan maestro RAG
--
-- What this adds:
--   1. summaries.embedding vector(768) — same dims as chunks
--   2. HNSW index on summaries.embedding (partial, skips NULLs)
--   3. rag_coarse_to_fine_search() RPC — two-stage vector search
--
-- Search strategy:
--   Stage 1 (Coarse): Find top-N summaries by embedding similarity
--   Stage 2 (Fine):   Find top-K chunks within those summaries
--   Score:            0.3 × summary_sim + 0.7 × chunk_sim
--
-- Why 70/30 weighting:
--   The chunk contains the specific information answering the query.
--   The summary embedding confirms we're in the right topic (macro-relevance).
--   50/50 would over-rank summaries with mediocre chunks.
--
-- Transition plan:
--   Existing summaries won't have embeddings after this migration.
--   They're filled via:
--     a) POST /ai/ingest-embeddings { target: "summaries" } (batch)
--     b) autoChunkAndEmbed() on summary create/update (auto)
--   chat.ts has a fallback: if coarse-to-fine returns 0, uses hybrid search.
--
-- Prerequisites:
--   - pgvector extension enabled (done in 20260305_03)
--   - summaries.institution_id column exists (done in 20260304_06)
-- ============================================================================

-- ════════════════════════════════════════════════════════════════════
-- 1. Embedding column on summaries
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE summaries
  ADD COLUMN IF NOT EXISTS embedding vector(768);

COMMENT ON COLUMN summaries.embedding IS
  'Summary-level embedding (768d, gemini-embedding-001). '
  'Generated from title + content_markdown. '
  'Used by rag_coarse_to_fine_search for macro-level retrieval.';

-- ════════════════════════════════════════════════════════════════════
-- 2. HNSW index on summaries.embedding
-- ════════════════════════════════════════════════════════════════════
--
-- Partial index: only indexes rows WHERE embedding IS NOT NULL.
-- Benefits:
--   - Zero overhead during transition (no NULLs indexed)
--   - Smaller index footprint (~100-1K summaries vs ~10K chunks)
--   - hnsw works with 0 initial rows (unlike ivfflat)
--
-- Parameters:
--   m = 16           — connections per node (same as chunks index)
--   ef_construction = 64 — build-time quality (same as chunks index)

CREATE INDEX IF NOT EXISTS idx_summaries_embedding_hnsw
  ON summaries USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE embedding IS NOT NULL;

-- ════════════════════════════════════════════════════════════════════
-- 3. Coarse-to-Fine search RPC
-- ════════════════════════════════════════════════════════════════════
--
-- Two-stage vector search for broad queries (no summary_id scope).
--
-- Stage 1: Find top-N summaries by embedding cosine similarity.
--          Uses summaries.institution_id (denormalized, 0 extra JOINs).
--
-- Stage 2: Within those summaries, find best chunks by embedding
--          cosine similarity. Combines scores as weighted average.
--
-- Global LIMIT (not per-summary):
--   If one summary has the 5 best chunks, we want all 5.
--   Per-summary limit would force artificial diversity that
--   hurts answer quality. Natural diversity comes from the
--   summary_similarity boost — equally relevant summaries
--   compete equitably.
--
-- Chunk filtering:
--   - ch.embedding IS NOT NULL: skip chunks without embeddings
--   - NO ch.deleted_at filter: chunks use hard DELETE (consistent
--     with rag_hybrid_search)
--
-- Performance:
--   - Stage 1 uses idx_summaries_embedding_hnsw (ANN scan, ~1ms)
--   - Stage 2 scans chunks of top-N summaries only (~50-200 rows)
--   - Total expected latency: ~5-15ms for typical workload

CREATE OR REPLACE FUNCTION rag_coarse_to_fine_search(
  p_query_embedding   vector(768),
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

  -- Stage 1: Coarse — find most relevant summaries
  WITH top_summaries AS (
    SELECT
      s.id,
      s.title,
      (1 - (s.embedding <=> p_query_embedding))::FLOAT AS sim
    FROM summaries s
    WHERE s.embedding IS NOT NULL
      AND s.institution_id = p_institution_id
      AND s.deleted_at IS NULL
      AND s.is_active = TRUE
      AND (1 - (s.embedding <=> p_query_embedding)) > p_similarity_threshold
    ORDER BY s.embedding <=> p_query_embedding  -- ASC = closest first
    LIMIT p_top_summaries
  ),

  -- Stage 2: Fine — find best chunks within those summaries
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

COMMENT ON FUNCTION rag_coarse_to_fine_search IS
  'Two-stage RAG search: summary embedding → chunk embedding. '
  'Score = 0.3 × summary_sim + 0.7 × chunk_sim. '
  'Fase 3 — Bloque 2 del plan maestro RAG.';

-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_has_embedding   BOOLEAN;
  v_has_hnsw_index  BOOLEAN;
  v_has_rpc         BOOLEAN;
BEGIN
  -- Check summaries.embedding column
  SELECT EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'summaries' AND column_name = 'embedding'
  ) INTO v_has_embedding;

  -- Check HNSW index
  SELECT EXISTS(
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'idx_summaries_embedding_hnsw'
  ) INTO v_has_hnsw_index;

  -- Check RPC exists
  SELECT EXISTS(
    SELECT 1 FROM pg_proc WHERE proname = 'rag_coarse_to_fine_search'
  ) INTO v_has_rpc;

  RAISE NOTICE '══════════════════════════════════════════════';
  RAISE NOTICE '  FASE 3 MIGRATION VERIFICATION';
  RAISE NOTICE '══════════════════════════════════════════════';
  RAISE NOTICE '  summaries.embedding:          %', CASE WHEN v_has_embedding  THEN 'OK' ELSE 'MISSING!' END;
  RAISE NOTICE '  idx_summaries_embedding_hnsw: %', CASE WHEN v_has_hnsw_index THEN 'OK' ELSE 'MISSING!' END;
  RAISE NOTICE '  rag_coarse_to_fine_search:    %', CASE WHEN v_has_rpc        THEN 'OK' ELSE 'MISSING!' END;
  RAISE NOTICE '══════════════════════════════════════════════';

  IF NOT v_has_embedding OR NOT v_has_hnsw_index OR NOT v_has_rpc THEN
    RAISE WARNING 'Some components are missing! Check the notices above.';
  ELSE
    RAISE NOTICE '  ALL CHECKS PASSED — Fase 3 schema ready.';
  END IF;
END;
$$;

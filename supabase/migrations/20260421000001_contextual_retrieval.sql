-- ============================================================================
-- Migration: Contextual Retrieval (Anthropic pattern) — chunks
-- Date: 2026-04-21
-- Purpose: Add contextual chunking columns + backfill helper RPC.
--
-- Anthropic Contextual Retrieval pattern:
--   https://www.anthropic.com/news/contextual-retrieval
--
-- For each chunk, an LLM (Haiku 4.5) produces a 1-2 sentence contextual
-- prefix that situates the chunk inside its parent summary. We embed that
-- contextualized text and store it alongside the raw chunk embedding. At
-- retrieval time we can A/B between the two embedding columns without
-- re-embedding.
--
-- Storage cost: ~250MB extra per 20k chunks (1536 floats x 4 bytes x 2).
-- Worth it: flag-opt-in rollout + A/B testing flexibility.
--
-- Idempotent: all ADD/CREATE statements use IF NOT EXISTS.
-- Rollback: DROP COLUMN contextual_content, contextual_embedding, contextual_model.
-- ============================================================================

BEGIN;

-- ─── Columns ─────────────────────────────────────────────────────────────

ALTER TABLE chunks ADD COLUMN IF NOT EXISTS contextual_content TEXT;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS contextual_embedding vector(1536);
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS contextual_model TEXT;

COMMENT ON COLUMN chunks.contextual_content IS
  'Contextualized chunk text: 1-2 LLM-generated sentences of context + original chunk content. Source: Anthropic Contextual Retrieval pattern.';

COMMENT ON COLUMN chunks.contextual_embedding IS
  'Embedding (1536d, OpenAI text-embedding-3-large) of contextual_content. Enables A/B retrieval vs the raw embedding column.';

COMMENT ON COLUMN chunks.contextual_model IS
  'Model ID that produced contextual_content. Values: claude-haiku-4-5-20251001 (success), fallback-plain (LLM failed, contextual_content copies raw chunk).';

-- ─── Indexes ─────────────────────────────────────────────────────────────

-- Backfill worker driver: "next pending chunks, ordered within summary".
-- Partial WHERE keeps the index tiny (only pending rows).
CREATE INDEX IF NOT EXISTS idx_chunks_needs_contextual
  ON chunks (summary_id, order_index)
  WHERE contextual_content IS NULL AND embedding IS NOT NULL;

-- HNSW index on contextual_embedding for future A/B retrieval (Fase 2).
-- Created now while column is empty — index builds instantly; deferring
-- until after backfill would require a 20k-row reindex.
CREATE INDEX IF NOT EXISTS idx_chunks_contextual_embedding
  ON chunks USING hnsw (contextual_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ─── Helper RPC: drive backfill worker ───────────────────────────────────
--
-- Returns chunks pending contextualization, ordered by (summary_id, order_index)
-- so callers can group by summary and resolve the parent summary's source text
-- exactly once per group.
--
-- Scope filters:
--   - p_summary_id: narrow to a single summary (edge function path).
--   - p_institution_id: narrow to an institution (production backfill path).
--
-- SECURITY MODEL:
--   SECURITY INVOKER — intentional. The chunks table has RLS policies
--   (chunks_members_select) that gate reads through summaries.institution_id
--   against user_institution_ids(). That policy does the right thing for
--   every caller type:
--     - authenticated user → scoped to their institutions
--     - service_role       → bypasses RLS (script/edge function path)
--     - anon               → no rows (no anon policy)
--   This lets us avoid REVOKE/GRANT boilerplate while keeping the function
--   safe to expose. Writes in the UPDATE path are service_role only, per
--   the application's existing admin client pattern.
--
-- Returned fields are enough for the TypeScript caller to:
--   (a) identify the chunk (chunk_id),
--   (b) know which summary it belongs to (summary_id + summary_title for the prompt),
--   (c) know its position in the summary (order_index for the "chunk N of M" hint).
-- Source text is NOT returned here; the caller resolves blocks->markdown itself,
-- matching the source-of-truth logic in auto-ingest.ts.

CREATE OR REPLACE FUNCTION get_chunks_for_contextual(
  p_summary_id UUID DEFAULT NULL,
  p_institution_id UUID DEFAULT NULL,
  p_limit INT DEFAULT 50
)
RETURNS TABLE (
  chunk_id UUID,
  summary_id UUID,
  content TEXT,
  order_index INT,
  summary_title TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT
    ch.id            AS chunk_id,
    ch.summary_id    AS summary_id,
    ch.content       AS content,
    ch.order_index   AS order_index,
    s.title          AS summary_title
  FROM chunks ch
  JOIN summaries s ON s.id = ch.summary_id
  WHERE ch.contextual_content IS NULL
    AND ch.embedding IS NOT NULL
    AND (p_summary_id IS NULL OR ch.summary_id = p_summary_id)
    AND (p_institution_id IS NULL OR s.institution_id = p_institution_id)
  ORDER BY ch.summary_id, ch.order_index
  LIMIT GREATEST(COALESCE(p_limit, 50), 1);
END;
$$;

COMMENT ON FUNCTION get_chunks_for_contextual IS
  'Backfill driver for Contextual Retrieval. Returns pending chunks ordered by (summary_id, order_index). SECURITY INVOKER — relies on chunks RLS for authenticated access control.';

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- Migration: Add FTS scoring to rag_coarse_to_fine_search
--
-- Adds optional p_query_text parameter for full-text search scoring.
-- When provided, uses ts_rank() with Spanish config to blend semantic
-- and lexical similarity:
--   combined_score = 0.25 * summary_sim + 0.55 * chunk_sim + 0.20 * fts_rank
--
-- When NULL (backward compat), keeps original formula:
--   combined_score = 0.3 * summary_sim + 0.7 * chunk_sim
--
-- Security: PRESERVES SECURITY DEFINER, search_path, auth.uid() check,
-- and REVOKE/GRANT from 20260311_02_rag_security_hardening.sql.
-- ════════════════════════════════════════════════════════════════════

-- Drop old 5-param signature to prevent PostgreSQL function overload.
-- CREATE OR REPLACE with different param count creates a second function,
-- not a replacement. This ensures only the new 6-param version exists.
DROP FUNCTION IF EXISTS rag_coarse_to_fine_search(vector(1536), UUID, INT, INT, FLOAT);

CREATE OR REPLACE FUNCTION rag_coarse_to_fine_search(
  p_query_embedding      vector(1536),
  p_institution_id       UUID,
  p_top_summaries        INT   DEFAULT 3,
  p_top_chunks           INT   DEFAULT 5,
  p_similarity_threshold FLOAT DEFAULT 0.3,
  p_query_text           TEXT  DEFAULT NULL
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
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Layer 2: Defense-in-depth auth check.
  IF auth.uid() IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM memberships
      WHERE user_id = auth.uid()
        AND institution_id = p_institution_id
        AND is_active = true
    ) THEN
      RAISE EXCEPTION 'Access denied: caller is not a member of institution %', p_institution_id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

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
      (1 - (ch.embedding <=> p_query_embedding))::FLOAT AS c_sim,
      CASE
        WHEN p_query_text IS NOT NULL AND ch.fts IS NOT NULL
        THEN ts_rank(ch.fts, plainto_tsquery('spanish', p_query_text))
        ELSE 0.0
      END::FLOAT AS trank
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
    CASE
      WHEN p_query_text IS NOT NULL
      THEN (0.25 * sc.s_sim + 0.55 * sc.c_sim + 0.20 * sc.trank)::FLOAT
      ELSE (0.3 * sc.s_sim + 0.7 * sc.c_sim)::FLOAT
    END                  AS combined_score
  FROM scored_chunks sc
  ORDER BY
    CASE
      WHEN p_query_text IS NOT NULL
      THEN (0.25 * sc.s_sim + 0.55 * sc.c_sim + 0.20 * sc.trank)
      ELSE (0.3 * sc.s_sim + 0.7 * sc.c_sim)
    END DESC
  LIMIT p_top_chunks;
END;
$$;

COMMENT ON FUNCTION rag_coarse_to_fine_search IS
  'Two-stage RAG search v4 — adds optional FTS scoring (ts_rank Spanish).';

-- Revoke old 5-param signature if it exists (CREATE OR REPLACE doesn't drop it)
DO $$ BEGIN
  REVOKE EXECUTE ON FUNCTION rag_coarse_to_fine_search(
    vector(1536), UUID, INT, INT, FLOAT
  ) FROM anon, authenticated;
EXCEPTION WHEN undefined_function THEN NULL;
END $$;

-- Re-apply REVOKE/GRANT with updated 6-param signature
REVOKE EXECUTE ON FUNCTION rag_coarse_to_fine_search(
  vector(1536), UUID, INT, INT, FLOAT, TEXT
) FROM anon, authenticated;

GRANT EXECUTE ON FUNCTION rag_coarse_to_fine_search(
  vector(1536), UUID, INT, INT, FLOAT, TEXT
) TO service_role;

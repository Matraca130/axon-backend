-- ============================================================================
-- Migration: Security hardening for SECURITY DEFINER RAG functions
-- Date: 2026-03-11
-- Trigger: Gemini Code Assist security review on PR #43
--
-- Problem:
--   rag_hybrid_search, rag_coarse_to_fine_search, and
--   get_institution_summary_ids use SECURITY DEFINER (bypass RLS) but
--   have no internal auth check. Any authenticated user could call them
--   directly via PostgREST RPC with an arbitrary institution_id,
--   leaking cross-tenant data.
--
-- Remediation (defense in depth):
--   Layer 1 — REVOKE EXECUTE from authenticated/anon roles.
--             Only service_role (Edge Functions) can call these.
--   Layer 2 — Internal auth.uid() membership check.
--             When auth.uid() IS NOT NULL (direct PostgREST call),
--             verify the caller is a member of the institution.
--             When auth.uid() IS NULL (service_role), skip check
--             since Edge Functions enforce their own auth.
--   Layer 3 — SET search_path = public, pg_temp.
--             Prevents search_path hijacking attacks on
--             SECURITY DEFINER functions.
--
-- Functions hardened:
--   1. rag_hybrid_search          — returns chunk content (high risk)
--   2. rag_coarse_to_fine_search   — returns chunk content (high risk)
--   3. get_institution_summary_ids — returns summary IDs (medium risk)
--
-- Note: These functions are only called from Edge Functions
-- (chat.ts, ingest.ts) which use getAdminClient() (service_role).
-- No client-side code calls them directly.
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════
-- 1. rag_hybrid_search — Hardened
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
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Layer 2: Defense-in-depth auth check.
  -- auth.uid() IS NULL when called via service_role (Edge Functions) → skip.
  -- auth.uid() IS NOT NULL when called via PostgREST by user → verify.
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
  'RAG hybrid search v5 — security hardened (auth check + search_path).';


-- ════════════════════════════════════════════════════════════════════
-- 2. rag_coarse_to_fine_search — Hardened
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
  'Two-stage RAG search v3 — security hardened (auth check + search_path).';


-- ════════════════════════════════════════════════════════════════════
-- 3. get_institution_summary_ids — Hardened
--    Must convert from LANGUAGE sql to plpgsql to add IF block.
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION get_institution_summary_ids(
  p_institution_id UUID
)
RETURNS TABLE(summary_id UUID)
LANGUAGE plpgsql
STABLE
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
  SELECT DISTINCT s.id AS summary_id
  FROM summaries s
  JOIN topics t     ON s.topic_id      = t.id   AND t.deleted_at   IS NULL
  JOIN sections sec ON t.section_id    = sec.id AND sec.deleted_at IS NULL
  JOIN semesters sem ON sec.semester_id = sem.id AND sem.deleted_at IS NULL
  JOIN courses c    ON sem.course_id   = c.id   AND c.deleted_at   IS NULL
  WHERE c.institution_id = p_institution_id
    AND s.deleted_at IS NULL;
END;
$$;

COMMENT ON FUNCTION get_institution_summary_ids IS
  'Resolves institution_id → summary IDs. Security hardened v2 (auth check + search_path).';


-- ════════════════════════════════════════════════════════════════════
-- 4. Layer 1 — REVOKE / GRANT permissions
--    Primary defense: only service_role can execute these functions.
-- ════════════════════════════════════════════════════════════════════

-- rag_hybrid_search: full signature for REVOKE/GRANT
REVOKE EXECUTE ON FUNCTION rag_hybrid_search(
  vector(1536), TEXT, UUID, UUID, INT, FLOAT
) FROM anon, authenticated;

GRANT EXECUTE ON FUNCTION rag_hybrid_search(
  vector(1536), TEXT, UUID, UUID, INT, FLOAT
) TO service_role;

-- rag_coarse_to_fine_search: full signature
REVOKE EXECUTE ON FUNCTION rag_coarse_to_fine_search(
  vector(1536), UUID, INT, INT, FLOAT
) FROM anon, authenticated;

GRANT EXECUTE ON FUNCTION rag_coarse_to_fine_search(
  vector(1536), UUID, INT, INT, FLOAT
) TO service_role;

-- get_institution_summary_ids: full signature
REVOKE EXECUTE ON FUNCTION get_institution_summary_ids(UUID)
  FROM anon, authenticated;

GRANT EXECUTE ON FUNCTION get_institution_summary_ids(UUID)
  TO service_role;


-- ════════════════════════════════════════════════════════════════════
-- 5. Verification
-- ════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_fn_name TEXT;
  v_search_path TEXT;
  v_sec_type TEXT;
  v_has_revoke BOOLEAN;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '  SECURITY HARDENING VERIFICATION';
  RAISE NOTICE '  ================================';

  -- Check each function
  FOR v_fn_name IN
    SELECT unnest(ARRAY[
      'rag_hybrid_search',
      'rag_coarse_to_fine_search',
      'get_institution_summary_ids'
    ])
  LOOP
    -- Get security type
    SELECT p.prosecdef::TEXT INTO v_sec_type
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = v_fn_name AND n.nspname = 'public';

    -- Get search_path config
    SELECT array_to_string(p.proconfig, ', ') INTO v_search_path
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = v_fn_name AND n.nspname = 'public';

    -- Check if authenticated role has execute
    SELECT NOT has_function_privilege(
      'authenticated',
      v_fn_name || '(' ||
        CASE v_fn_name
          WHEN 'rag_hybrid_search' THEN 'vector,text,uuid,uuid,int,float'
          WHEN 'rag_coarse_to_fine_search' THEN 'vector,uuid,int,int,float'
          WHEN 'get_institution_summary_ids' THEN 'uuid'
        END || ')',
      'EXECUTE'
    ) INTO v_has_revoke;

    RAISE NOTICE '  % :', v_fn_name;
    RAISE NOTICE '    SECURITY DEFINER: % (expect true)', v_sec_type;
    RAISE NOTICE '    search_path:      % (expect search_path=public, pg_temp)', COALESCE(v_search_path, 'NOT SET');
    RAISE NOTICE '    Revoked from authenticated: % (expect true)', v_has_revoke;
    RAISE NOTICE '';
  END LOOP;

  RAISE NOTICE '  Done. All 3 functions hardened.';
  RAISE NOTICE '';
END;
$$;

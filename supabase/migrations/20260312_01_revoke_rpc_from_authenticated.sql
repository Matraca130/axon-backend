-- ═══════════════════════════════════════════════════════════════════════════
-- Migration: 20260312_01_revoke_rpc_from_authenticated.sql
-- Purpose: SEC-01 — Remove direct PostgREST RPC access for authenticated users
-- ═══════════════════════════════════════════════════════════════════════════
--
-- CONTEXT:
--   rag_hybrid_search and rag_coarse_to_fine_search are SECURITY DEFINER
--   functions that bypass RLS. They are exposed to the 'authenticated' role
--   via PostgREST RPC, meaning any logged-in user can call them with an
--   arbitrary p_institution_id to exfiltrate search results from other
--   institutions.
--
-- WHY IT'S SAFE:
--   Both functions are ONLY called from Edge Functions (chat.ts, via
--   supabase-js client instantiated with service_role key). The service_role
--   has its own EXECUTE privilege and is NOT affected by this REVOKE.
--
-- PREREQUISITE:
--   chat.ts MUST be deployed with adminDb (getAdminClient()) for RPC calls
--   BEFORE this migration is applied. Otherwise: total chat outage.
--   See: https://github.com/Matraca130/axon-backend/issues/45
--
-- VERIFICATION AFTER DEPLOY:
--   1. POST /ai/rag-chat should still work (uses service_role internally)
--   2. Direct RPC call from authenticated client should fail with:
--      "permission denied for function rag_hybrid_search"
--
-- SOURCE: Gemini Code Assist review on PR #43
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Step 1: Revoke EXECUTE from authenticated role ──────────────────────
--
-- The function signatures must match EXACTLY what was defined in the
-- CREATE FUNCTION statement. These were verified against:
--   - supabase/migrations/20260311_01_embedding_migration_1536.sql
--   - chat.ts RPC calls (p_query_embedding, p_query_text, etc.)

REVOKE EXECUTE
  ON FUNCTION rag_hybrid_search(
    vector(1536),  -- p_query_embedding
    TEXT,          -- p_query_text
    UUID,          -- p_institution_id
    UUID,          -- p_summary_id (nullable)
    INT,           -- p_match_count
    FLOAT          -- p_similarity_threshold
  )
  FROM authenticated;

REVOKE EXECUTE
  ON FUNCTION rag_coarse_to_fine_search(
    vector(1536),  -- p_query_embedding
    UUID,          -- p_institution_id
    INT,           -- p_top_summaries
    INT,           -- p_top_chunks
    FLOAT          -- p_similarity_threshold
  )
  FROM authenticated;

-- ─── Step 2: Prevent search_path hijacking ───────────────────────────────
--
-- SECURITY DEFINER functions inherit the creator's privileges but also
-- the session's search_path. An attacker could create a schema with
-- malicious functions that shadow public functions. Setting search_path
-- explicitly prevents this.

ALTER FUNCTION rag_hybrid_search SET search_path = public;
ALTER FUNCTION rag_coarse_to_fine_search SET search_path = public;

-- ─── Step 3: Add documentation comments ──────────────────────────────────

COMMENT ON FUNCTION rag_hybrid_search IS
  'RAG hybrid search (70% semantic + 30% FTS). '
  'SECURITY DEFINER — only callable via service_role (Edge Functions). '
  'REVOKE from authenticated applied in 20260312_01.';

COMMENT ON FUNCTION rag_coarse_to_fine_search IS
  'RAG coarse-to-fine search (summary-level then chunk-level). '
  'SECURITY DEFINER — only callable via service_role (Edge Functions). '
  'REVOKE from authenticated applied in 20260312_01.';

-- ─── Step 4: Verification ────────────────────────────────────────────────
--
-- This anonymous block runs at migration time and logs whether the
-- REVOKE was successful. If either function is still accessible to
-- 'authenticated', it prints a WARNING.

DO $$
DECLARE
  v_hybrid BOOLEAN;
  v_c2f BOOLEAN;
BEGIN
  -- Check if authenticated can still execute
  SELECT has_function_privilege(
    'authenticated',
    'rag_hybrid_search(vector,text,uuid,uuid,int,float)',
    'EXECUTE'
  ) INTO v_hybrid;

  SELECT has_function_privilege(
    'authenticated',
    'rag_coarse_to_fine_search(vector,uuid,int,int,float)',
    'EXECUTE'
  ) INTO v_c2f;

  RAISE NOTICE '════════════════════════════════════════════════════';
  RAISE NOTICE 'SEC-01 VERIFICATION:';
  RAISE NOTICE '  rag_hybrid_search → authenticated EXECUTE = % (expect FALSE)', v_hybrid;
  RAISE NOTICE '  rag_coarse_to_fine_search → authenticated EXECUTE = % (expect FALSE)', v_c2f;
  RAISE NOTICE '════════════════════════════════════════════════════';

  IF v_hybrid OR v_c2f THEN
    RAISE WARNING 'SEC-01 REVOKE MAY HAVE FAILED — check function signatures';
  END IF;
END;
$$;

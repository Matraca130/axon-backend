-- SEC-01: Remove direct PostgREST RPC access for authenticated users
-- rag_hybrid_search and rag_coarse_to_fine_search are SECURITY DEFINER
-- functions that bypass RLS. They were exposed to the 'authenticated' role
-- via PostgREST RPC.
--
-- PREREQUISITE: chat.ts MUST use getAdminClient() for these RPCs
-- BEFORE this migration is applied.
-- See: https://github.com/Matraca130/axon-backend/issues/45

-- Step 1: Revoke EXECUTE from authenticated role
-- Signatures verified against 20260311_01_embedding_migration_1536.sql

REVOKE EXECUTE
  ON FUNCTION rag_hybrid_search(
    vector(1536),
    TEXT,
    UUID,
    UUID,
    INT,
    FLOAT
  )
  FROM authenticated;

REVOKE EXECUTE
  ON FUNCTION rag_coarse_to_fine_search(
    vector(1536),
    UUID,
    INT,
    INT,
    FLOAT
  )
  FROM authenticated;

-- Step 2: Prevent search_path hijacking on SECURITY DEFINER functions
ALTER FUNCTION rag_hybrid_search SET search_path = public;
ALTER FUNCTION rag_coarse_to_fine_search SET search_path = public;

-- Step 3: Documentation comments
COMMENT ON FUNCTION rag_hybrid_search IS
  'RAG hybrid search (70% semantic + 30% FTS). '
  'SECURITY DEFINER - only callable via service_role (Edge Functions). '
  'REVOKE from authenticated applied in 20260312_01.';

COMMENT ON FUNCTION rag_coarse_to_fine_search IS
  'RAG coarse-to-fine search (summary-level then chunk-level). '
  'SECURITY DEFINER - only callable via service_role (Edge Functions). '
  'REVOKE from authenticated applied in 20260312_01.';

-- Step 4: Verification
DO $$
DECLARE
  v_hybrid BOOLEAN;
  v_c2f BOOLEAN;
BEGIN
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

  RAISE NOTICE 'SEC-01 VERIFICATION:';
  RAISE NOTICE '  rag_hybrid_search accessible to authenticated: % (expect FALSE)', v_hybrid;
  RAISE NOTICE '  rag_coarse_to_fine_search accessible to authenticated: % (expect FALSE)', v_c2f;

  IF v_hybrid OR v_c2f THEN
    RAISE WARNING 'SEC-01 REVOKE MAY HAVE FAILED - check function signatures';
  END IF;
END;
$$;

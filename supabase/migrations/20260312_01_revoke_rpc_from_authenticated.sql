-- SEC-01 v3: REVOKE via OID (nuclear option)
-- Replaces v1 (explicit signature REVOKE) which failed due to
-- ALTER DEFAULT PRIVILEGES in Supabase's pg_default_acl.
--
-- Root cause: Supabase auto-grants EXECUTE to authenticated/anon
-- for ALL functions in the public schema. A simple REVOKE doesn't
-- stick because default privileges re-grant on function changes.
--
-- This approach finds functions by OID in pg_proc and revokes
-- unambiguously, covering all overloads.
--
-- PREREQUISITE: chat.ts MUST use getAdminClient() for these RPCs
-- BEFORE this migration is applied. (Done in PR #46, commit b13aee1)
--
-- See: https://github.com/Matraca130/axon-backend/issues/45
--
-- Idempotent: safe to re-apply. Already applied to production.
-- Apply with: supabase db push --linked  OR  paste in SQL Editor.

DO $$
DECLARE
  v_oid OID;
  v_sig TEXT;
  v_count INT := 0;
BEGIN
  RAISE NOTICE '══════════════════════════════════════════════════';
  RAISE NOTICE '  SEC-01 v3: OID-based REVOKE';
  RAISE NOTICE '══════════════════════════════════════════════════';

  -- ── rag_hybrid_search: find ALL overloads ──
  FOR v_oid, v_sig IN
    SELECT p.oid, p.oid::regprocedure::TEXT
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'rag_hybrid_search' AND n.nspname = 'public'
  LOOP
    RAISE NOTICE '  Processing: %', v_sig;
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM public', v_sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', v_sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', v_sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_sig);
    EXECUTE format('ALTER FUNCTION %s SET search_path = public', v_sig);
    v_count := v_count + 1;
  END LOOP;

  -- ── rag_coarse_to_fine_search: find ALL overloads ──
  FOR v_oid, v_sig IN
    SELECT p.oid, p.oid::regprocedure::TEXT
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'rag_coarse_to_fine_search' AND n.nspname = 'public'
  LOOP
    RAISE NOTICE '  Processing: %', v_sig;
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM public', v_sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', v_sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', v_sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_sig);
    EXECUTE format('ALTER FUNCTION %s SET search_path = public', v_sig);
    v_count := v_count + 1;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '  Functions processed: %', v_count;

  IF v_count = 0 THEN
    RAISE WARNING '  No functions found! Check schema.';
  END IF;

  -- ── Verification ──
  RAISE NOTICE '';
  RAISE NOTICE '  ── VERIFICATION ──';

  FOR v_oid, v_sig IN
    SELECT p.oid, p.oid::regprocedure::TEXT
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname IN ('rag_hybrid_search', 'rag_coarse_to_fine_search')
      AND n.nspname = 'public'
  LOOP
    DECLARE
      v_auth BOOLEAN;
      v_anon BOOLEAN;
      v_pub  BOOLEAN;
      v_svc  BOOLEAN;
    BEGIN
      SELECT has_function_privilege('authenticated', v_oid, 'EXECUTE') INTO v_auth;
      SELECT has_function_privilege('anon',          v_oid, 'EXECUTE') INTO v_anon;
      SELECT has_function_privilege('public',        v_oid, 'EXECUTE') INTO v_pub;
      SELECT has_function_privilege('service_role',  v_oid, 'EXECUTE') INTO v_svc;

      RAISE NOTICE '  % :', v_sig;
      RAISE NOTICE '    authenticated: % (expect f)', v_auth;
      RAISE NOTICE '    anon:          % (expect f)', v_anon;
      RAISE NOTICE '    public:        % (expect f)', v_pub;
      RAISE NOTICE '    service_role:  % (expect t)', v_svc;

      IF v_auth OR v_anon THEN
        RAISE WARNING '  ^^^ STILL ACCESSIBLE — check pg_default_acl';
      END IF;
    END;
  END LOOP;

  RAISE NOTICE '══════════════════════════════════════════════════';
END;
$$;

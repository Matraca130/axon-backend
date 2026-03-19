-- ============================================================================
-- Migration: Security hardening for bulk_reorder SECURITY DEFINER function
-- Date: 2026-03-19
-- Branch: security/phase-3-access-control
--
-- Problem:
--   bulk_reorder uses SECURITY DEFINER (bypasses RLS) and was GRANTed to
--   anon + authenticated. Any authenticated user could call it via PostgREST
--   RPC and reorder content in any institution, or reorder another user's
--   study plan tasks.
--
-- Remediation (defense in depth, same pattern as 20260311_02):
--   Layer 0 -- Table allowlist (already existed, preserved)
--   Layer 1 -- REVOKE from PUBLIC/anon/authenticated, GRANT to service_role only
--   Layer 2 -- Internal auth.uid() check when called outside service_role:
--              - Content tables: resolve institution via resolve_parent_institution(),
--                then verify caller has CONTENT_WRITE role (owner/admin/professor)
--              - study_plan_tasks: verify task belongs to caller via study_plans.student_id
--   Layer 3 -- SET search_path = public, pg_temp (prevents search_path hijacking)
--
-- The function is FUNCTIONALLY IDENTICAL to the original except for the
-- security layers added. All existing logic is preserved.
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════
-- 1. DROP the old signature to avoid function overloading
-- ════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS bulk_reorder(text, jsonb);


-- ════════════════════════════════════════════════════════════════════
-- 2. CREATE the hardened function
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION bulk_reorder(
  p_table text,
  p_items jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp                          -- Layer 3
AS $$
DECLARE
  v_count int;
  v_has_updated_at bool;
  v_first_id uuid;
  v_institution_id uuid;
  v_caller_role text;
BEGIN
  -- ── Layer 0: Table allowlist (belt-and-suspenders with Hono validation) ──
  IF p_table NOT IN (
    'courses', 'semesters', 'sections', 'topics', 'summaries',
    'chunks', 'subtopics', 'videos', 'models_3d', 'model_3d_pins',
    'study_plan_tasks'
  ) THEN
    RAISE EXCEPTION 'Table "%" not allowed for reorder', p_table;
  END IF;

  -- ── Validate items array ──
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'p_items must be a non-empty JSON array';
  END IF;

  IF jsonb_array_length(p_items) > 200 THEN
    RAISE EXCEPTION 'Too many items: % (max 200)', jsonb_array_length(p_items);
  END IF;

  -- ── Layer 2: Defense-in-depth auth check ──
  -- auth.uid() IS NULL when called via service_role (Edge Functions) -> skip.
  -- auth.uid() IS NOT NULL when called via PostgREST by user -> verify.
  IF auth.uid() IS NOT NULL THEN

    v_first_id := (p_items->0->>'id')::uuid;

    IF p_table = 'study_plan_tasks' THEN
      -- study_plan_tasks: verify the task belongs to the caller
      IF NOT EXISTS (
        SELECT 1
        FROM study_plan_tasks spt
        JOIN study_plans sp ON sp.id = spt.study_plan_id
        WHERE spt.id = v_first_id
          AND sp.student_id = auth.uid()
      ) THEN
        RAISE EXCEPTION 'Access denied: study_plan_task does not belong to caller'
          USING ERRCODE = 'insufficient_privilege';
      END IF;

    ELSE
      -- Content tables: resolve institution, then check CONTENT_WRITE role
      v_institution_id := resolve_parent_institution(p_table, v_first_id);

      IF v_institution_id IS NULL THEN
        RAISE EXCEPTION 'Access denied: could not resolve institution for %.%', p_table, v_first_id
          USING ERRCODE = 'insufficient_privilege';
      END IF;

      SELECT m.role INTO v_caller_role
      FROM memberships m
      WHERE m.user_id = auth.uid()
        AND m.institution_id = v_institution_id
        AND m.is_active = true;

      IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin', 'professor') THEN
        RAISE EXCEPTION 'Access denied: caller lacks CONTENT_WRITE role in institution %', v_institution_id
          USING ERRCODE = 'insufficient_privilege';
      END IF;

    END IF;

  END IF;

  -- ── Determine if table has updated_at column ──
  v_has_updated_at := p_table IN (
    'courses', 'semesters', 'sections', 'topics', 'summaries',
    'videos', 'models_3d', 'model_3d_pins'
  );

  -- ── Single UPDATE with join on jsonb_array_elements ──
  IF v_has_updated_at THEN
    EXECUTE format(
      'UPDATE %I t
       SET order_index = (i->>''order_index'')::int,
           updated_at  = now()
       FROM jsonb_array_elements($1) AS i
       WHERE t.id = (i->>''id'')::uuid',
      p_table
    ) USING p_items;
  ELSE
    EXECUTE format(
      'UPDATE %I t
       SET order_index = (i->>''order_index'')::int
       FROM jsonb_array_elements($1) AS i
       WHERE t.id = (i->>''id'')::uuid',
      p_table
    ) USING p_items;
  END IF;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN jsonb_build_object('reordered', v_count);
END;
$$;

COMMENT ON FUNCTION bulk_reorder IS
  'Bulk-update order_index for any orderable table. Security hardened v2 (auth check + search_path + REVOKE).';


-- ════════════════════════════════════════════════════════════════════
-- 3. Layer 1 -- REVOKE / GRANT permissions
--    Primary defense: only service_role can execute this function.
-- ════════════════════════════════════════════════════════════════════

REVOKE EXECUTE ON FUNCTION bulk_reorder(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION bulk_reorder(text, jsonb) TO service_role;


-- ════════════════════════════════════════════════════════════════════
-- 4. Verification
-- ════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_search_path TEXT;
  v_sec_type BOOLEAN;
  v_anon_revoked BOOLEAN;
  v_auth_revoked BOOLEAN;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '  BULK_REORDER SECURITY HARDENING VERIFICATION';
  RAISE NOTICE '  =============================================';

  -- Check SECURITY DEFINER
  SELECT p.prosecdef INTO v_sec_type
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'bulk_reorder' AND n.nspname = 'public';

  RAISE NOTICE '  SECURITY DEFINER: % (expect true)', v_sec_type;

  -- Check search_path
  SELECT array_to_string(p.proconfig, ', ') INTO v_search_path
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'bulk_reorder' AND n.nspname = 'public';

  RAISE NOTICE '  search_path:      % (expect search_path=public, pg_temp)', COALESCE(v_search_path, 'NOT SET');

  -- Check anon cannot execute
  SELECT NOT has_function_privilege('anon', 'bulk_reorder(text,jsonb)', 'EXECUTE')
  INTO v_anon_revoked;

  RAISE NOTICE '  Revoked from anon:          % (expect true)', v_anon_revoked;

  -- Check authenticated cannot execute
  SELECT NOT has_function_privilege('authenticated', 'bulk_reorder(text,jsonb)', 'EXECUTE')
  INTO v_auth_revoked;

  RAISE NOTICE '  Revoked from authenticated: % (expect true)', v_auth_revoked;

  -- Final assertion
  IF v_sec_type AND v_search_path LIKE '%search_path=public, pg_temp%'
     AND v_anon_revoked AND v_auth_revoked THEN
    RAISE NOTICE '';
    RAISE NOTICE '  ALL CHECKS PASSED. bulk_reorder is hardened.';
  ELSE
    RAISE WARNING '  SOME CHECKS FAILED — review output above.';
  END IF;

  RAISE NOTICE '';
END;
$$;

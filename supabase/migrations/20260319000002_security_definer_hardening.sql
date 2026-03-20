-- ============================================================================
-- Migration: Security Definer Hardening (S9)
-- Date: 2026-03-19
-- Purpose: Harden all remaining SECURITY DEFINER functions that lack
--          search_path = public, pg_temp and/or have overly broad
--          EXECUTE grants.
--
-- PART A: SET search_path = public, pg_temp on all 12 unhardened functions
-- PART B: REVOKE EXECUTE from anon/authenticated for service_role-only RPCs
-- PART C: Verification block
--
-- Safety:
--   - ALTER FUNCTION only changes config, does NOT replace function body
--   - REVOKE/GRANT are idempotent
--   - No table or data changes
-- ============================================================================


-- ========================================================================
-- PART A: SET search_path for ALL unhardened SECURITY DEFINER functions
-- ========================================================================
-- Adding pg_temp to search_path prevents temp-object hijacking attacks.
-- Trigger functions already had SET search_path = public; we add pg_temp.
-- Other functions had no search_path set at all.
-- ========================================================================

-- ── Trigger functions (already had search_path = public, adding pg_temp) ──

ALTER FUNCTION on_review_inserted()
  SET search_path = public, pg_temp;

ALTER FUNCTION on_study_session_completed()
  SET search_path = public, pg_temp;

-- ── Functions without any search_path ──

ALTER FUNCTION upsert_video_view(uuid, uuid, uuid, int, int, numeric, boolean, int)
  SET search_path = public, pg_temp;

-- get_course_summary_ids: SKIPPED — function does not exist in production

ALTER FUNCTION get_student_knowledge_context(uuid, uuid)
  SET search_path = public, pg_temp;

ALTER FUNCTION resolve_parent_institution(text, uuid)
  SET search_path = public, pg_temp;

ALTER FUNCTION search_keywords_by_institution(uuid, text, uuid, uuid, int)
  SET search_path = public, pg_temp;

-- search_scoped: SKIPPED — function does not exist in production
-- trash_scoped: SKIPPED — function does not exist in production

ALTER FUNCTION rag_analytics_summary(uuid, timestamptz, timestamptz)
  SET search_path = public, pg_temp;

ALTER FUNCTION rag_embedding_coverage(uuid)
  SET search_path = public, pg_temp;

ALTER FUNCTION get_ai_report_stats(uuid, timestamptz, timestamptz)
  SET search_path = public, pg_temp;


-- ========================================================================
-- PART B: REVOKE — DEFERRED TO SEPARATE PR
-- ========================================================================
-- Quality gate audit (2026-03-18) found that 5 of 6 functions listed for
-- REVOKE are actually called via user client `db`, NOT adminDb:
--   - upsert_video_view      → mux/tracking.ts uses db
--   - get_course_summary_ids → keyword-search.ts, study-queue/resolvers.ts use db
--   - get_student_knowledge_context → generate.ts, chat.ts, generate-smart.ts use db
--   - rag_analytics_summary  → analytics.ts uses db
--   - rag_embedding_coverage → analytics.ts uses db
--   - get_ai_report_stats    → report-dashboard.ts uses db
--
-- REVOKING these would cause immediate "permission denied" in production.
-- The correct fix requires a TWO-STEP migration:
--   Step 1: Change all TS callers from db.rpc() to getAdminClient().rpc()
--   Step 2: Then REVOKE from authenticated (in a separate PR)
--
-- For now, PART A (search_path hardening) is sufficient to prevent
-- search_path hijacking attacks without breaking functionality.
-- ========================================================================


-- ========================================================================
-- PART C: Verification block
-- ========================================================================

DO $$
DECLARE
  v_fn TEXT;
  v_sp TEXT;
BEGIN
  RAISE NOTICE 'SECURITY DEFINER HARDENING VERIFICATION';
  FOR v_fn IN SELECT unnest(ARRAY[
    'upsert_video_view', 'get_student_knowledge_context',
    'resolve_parent_institution', 'search_keywords_by_institution',
    'rag_analytics_summary', 'rag_embedding_coverage', 'get_ai_report_stats',
    'on_review_inserted', 'on_study_session_completed'
  ]) LOOP
    SELECT array_to_string(p.proconfig, ', ') INTO v_sp
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = v_fn AND n.nspname = 'public' LIMIT 1;
    RAISE NOTICE '  %: config = %', v_fn, COALESCE(v_sp, 'NOT SET');
  END LOOP;
END; $$;

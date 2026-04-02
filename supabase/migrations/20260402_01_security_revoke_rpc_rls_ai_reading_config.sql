-- ============================================================================
-- Migration: SEC-S9B — REVOKE 6 RPCs from authenticated + RLS ai_reading_config
-- Date: 2026-04-02
--
-- PART A: REVOKE EXECUTE on 6 SECURITY DEFINER functions from authenticated.
--         All TS callers have been switched to getAdminClient() (service_role).
--
-- PART B: Tighten ai_reading_config RLS — drop INSERT/UPDATE for authenticated,
--         keep SELECT, add service_role full access.
-- ============================================================================


-- ========================================================================
-- PART A: REVOKE EXECUTE FROM authenticated on 6 functions
-- ========================================================================

-- 1. upsert_video_view (mux/tracking.ts → now uses getAdminClient)
REVOKE EXECUTE ON FUNCTION upsert_video_view(uuid, uuid, uuid, int, int, numeric, boolean, int)
  FROM authenticated;

-- 2. get_course_summary_ids (keyword-search.ts, resolvers.ts → now uses getAdminClient)
-- Note: may not exist in production (was flagged as possibly missing).
-- Use DO block to handle gracefully.
DO $$
BEGIN
  EXECUTE 'REVOKE EXECUTE ON FUNCTION get_course_summary_ids(uuid) FROM authenticated';
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE 'get_course_summary_ids(uuid) does not exist — skipping REVOKE';
END; $$;

-- 3. get_student_knowledge_context (generate.ts, chat.ts, generate-smart.ts → now uses getAdminClient)
REVOKE EXECUTE ON FUNCTION get_student_knowledge_context(uuid, uuid)
  FROM authenticated;

-- 4. rag_analytics_summary (analytics.ts → now uses getAdminClient)
REVOKE EXECUTE ON FUNCTION rag_analytics_summary(uuid, timestamptz, timestamptz)
  FROM authenticated;

-- 5. rag_embedding_coverage (analytics.ts → now uses getAdminClient)
REVOKE EXECUTE ON FUNCTION rag_embedding_coverage(uuid)
  FROM authenticated;

-- 6. get_ai_report_stats (report-dashboard.ts → now uses getAdminClient)
REVOKE EXECUTE ON FUNCTION get_ai_report_stats(uuid, timestamptz, timestamptz)
  FROM authenticated;

-- Grant to service_role (idempotent — already granted for most, but ensure)
GRANT EXECUTE ON FUNCTION upsert_video_view(uuid, uuid, uuid, int, int, numeric, boolean, int) TO service_role;
GRANT EXECUTE ON FUNCTION get_student_knowledge_context(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION rag_analytics_summary(uuid, timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION rag_embedding_coverage(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION get_ai_report_stats(uuid, timestamptz, timestamptz) TO service_role;

DO $$
BEGIN
  EXECUTE 'GRANT EXECUTE ON FUNCTION get_course_summary_ids(uuid) TO service_role';
EXCEPTION WHEN undefined_function THEN
  NULL;
END; $$;


-- ========================================================================
-- PART B: RLS ai_reading_config — restrict writes to service_role only
-- ========================================================================

-- Drop overly permissive write policies
DROP POLICY IF EXISTS "Authenticated users can insert ai_reading_config" ON ai_reading_config;
DROP POLICY IF EXISTS "Authenticated users can update ai_reading_config" ON ai_reading_config;

-- SELECT for authenticated stays:
--   "Authenticated users can read ai_reading_config" FOR SELECT USING (true)

-- Add service_role full access policy (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'ai_reading_config'
      AND policyname = 'ai_reading_config_service_role_all'
  ) THEN
    CREATE POLICY ai_reading_config_service_role_all
      ON ai_reading_config FOR ALL
      USING (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END; $$;


-- ========================================================================
-- PART C: Verification
-- ========================================================================

DO $$
DECLARE
  v_count INT;
BEGIN
  RAISE NOTICE '── SEC-S9B VERIFICATION ──';

  -- Check ai_reading_config policies
  SELECT count(*) INTO v_count
  FROM pg_policies
  WHERE tablename = 'ai_reading_config'
    AND policyname LIKE '%insert%';

  IF v_count = 0 THEN
    RAISE NOTICE '[OK] ai_reading_config — no INSERT policy for authenticated';
  ELSE
    RAISE WARNING '[UNEXPECTED] ai_reading_config — INSERT policy still exists';
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_policies
  WHERE tablename = 'ai_reading_config'
    AND policyname LIKE '%update%';

  IF v_count = 0 THEN
    RAISE NOTICE '[OK] ai_reading_config — no UPDATE policy for authenticated';
  ELSE
    RAISE WARNING '[UNEXPECTED] ai_reading_config — UPDATE policy still exists';
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_policies
  WHERE tablename = 'ai_reading_config'
    AND policyname = 'ai_reading_config_service_role_all';

  IF v_count = 1 THEN
    RAISE NOTICE '[OK] ai_reading_config — service_role_all policy present';
  ELSE
    RAISE WARNING '[MISSING] ai_reading_config — service_role_all policy not found!';
  END IF;
END; $$;

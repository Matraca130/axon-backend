-- ============================================================================
-- Migration: SEC-S9B — REVOKE 6 RPCs from authenticated
-- Date: 2026-04-02
--
-- REVOKE EXECUTE on 6 SECURITY DEFINER functions from authenticated.
-- All TS callers have been switched to getAdminClient() (service_role).
--
-- NOTE: ai_reading_config RLS changes moved to PR #184 (owner/admin scoped).
-- ============================================================================


-- ========================================================================
-- REVOKE EXECUTE FROM authenticated on 6 functions
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

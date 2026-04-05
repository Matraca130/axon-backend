-- ============================================================================
-- Migration: Revoke anon access from ALL SECURITY DEFINER RPCs (AXO-140)
-- Date: 2026-04-05
-- Issue: AXO-140 — 22 SECURITY DEFINER functions callable by anon
--
-- Problem:
--   22 SECURITY DEFINER functions in production are callable by `anon`
--   (unauthenticated users via PostgREST). This means any unauthenticated
--   API call can execute these functions with `postgres` owner privileges,
--   completely bypassing RLS.
--
-- Fix:
--   1. REVOKE ALL from PUBLIC and anon for each function
--   2. GRANT EXECUTE only to the minimum required role
--   3. Redefine functions missing SET search_path
--
-- Role classification:
--   - service_role: internal/admin/AI/RAG/cron functions
--   - authenticated: user-facing RPCs that use auth.uid()
--   - (none): trigger functions invoked only by DB triggers
--
-- Idempotent: REVOKE + GRANT are idempotent. CREATE OR REPLACE for redefined fns.
-- ============================================================================

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- GROUP 1: SERVICE_ROLE ONLY — internal/admin/AI/RAG/cron
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. award_xp(uuid, text, int, uuid, uuid)
REVOKE ALL ON FUNCTION award_xp FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION award_xp TO service_role;

-- 2. get_ai_report_stats(uuid, timestamp, timestamp)
REVOKE ALL ON FUNCTION get_ai_report_stats FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_ai_report_stats TO service_role;

-- 3. get_course_summary_ids(uuid)
REVOKE ALL ON FUNCTION get_course_summary_ids FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_course_summary_ids TO service_role;

-- 4. get_institution_summary_ids(uuid)
REVOKE ALL ON FUNCTION get_institution_summary_ids FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_institution_summary_ids TO service_role;

-- 5. get_student_knowledge_context(uuid)
REVOKE ALL ON FUNCTION get_student_knowledge_context FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_student_knowledge_context TO service_role;

-- 6. rag_analytics_summary(uuid)
REVOKE ALL ON FUNCTION rag_analytics_summary FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rag_analytics_summary TO service_role;

-- 7. rag_embedding_coverage(uuid)
REVOKE ALL ON FUNCTION rag_embedding_coverage FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rag_embedding_coverage TO service_role;

-- 8. resolve_student_summary_ids(uuid)
REVOKE ALL ON FUNCTION resolve_student_summary_ids FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION resolve_student_summary_ids TO service_role;

-- 9. resolve_parent_institution(uuid)
REVOKE ALL ON FUNCTION resolve_parent_institution FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION resolve_parent_institution TO service_role;

-- 10. upsert_video_view(uuid, uuid, uuid, int, int, numeric, boolean, int)
REVOKE ALL ON FUNCTION upsert_video_view FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION upsert_video_view TO service_role;

-- 11. trash_scoped(text, uuid[], uuid)
REVOKE ALL ON FUNCTION trash_scoped FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION trash_scoped TO service_role;

-- 12. compute_cohort_difficulty(uuid) — internal cohort analysis
REVOKE ALL ON FUNCTION compute_cohort_difficulty FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION compute_cohort_difficulty TO service_role;

-- 13. increment_daily_stat(uuid, text, int) — internal stat tracking
REVOKE ALL ON FUNCTION increment_daily_stat FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION increment_daily_stat TO service_role;

-- 14. refresh_leaderboard_weekly() — cron job
REVOKE ALL ON FUNCTION refresh_leaderboard_weekly FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION refresh_leaderboard_weekly TO service_role;

-- 15. reset_correct_streak(uuid) — internal streak management
REVOKE ALL ON FUNCTION reset_correct_streak FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reset_correct_streak TO service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- GROUP 2: AUTHENTICATED — user-facing RPCs
-- ═══════════════════════════════════════════════════════════════════════════

-- 16. create_text_annotation(uuid, int, int, text, text, uuid)
REVOKE ALL ON FUNCTION create_text_annotation FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_text_annotation TO authenticated;

-- 17. find_similar_topics(uuid, int, float8)
REVOKE ALL ON FUNCTION find_similar_topics FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION find_similar_topics TO authenticated;

-- 18. advisory_unlock(bigint)
REVOKE ALL ON FUNCTION advisory_unlock FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION advisory_unlock TO authenticated;

-- 19. try_advisory_lock(bigint)
REVOKE ALL ON FUNCTION try_advisory_lock FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION try_advisory_lock TO authenticated;

-- 20. user_institution_ids(uuid)
REVOKE ALL ON FUNCTION user_institution_ids FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION user_institution_ids TO authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- GROUP 3: TRIGGER-ONLY — no direct RPC grant needed
-- ═══════════════════════════════════════════════════════════════════════════

-- 21. on_review_inserted() — trigger function
REVOKE ALL ON FUNCTION on_review_inserted FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION on_review_inserted TO service_role;

-- 22. on_study_session_completed() — trigger function
REVOKE ALL ON FUNCTION on_study_session_completed FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION on_study_session_completed TO service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- GROUP 4: REDEFINE functions missing SET search_path
-- ═══════════════════════════════════════════════════════════════════════════

-- create_text_annotation — add search_path
CREATE OR REPLACE FUNCTION public.create_text_annotation(
  p_summary_id uuid,
  p_start_offset integer,
  p_end_offset integer,
  p_color text DEFAULT 'yellow',
  p_note text DEFAULT NULL,
  p_block_id uuid DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_student_id uuid;
  v_result json;
BEGIN
  v_student_id := auth.uid();
  IF v_student_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  INSERT INTO public.text_annotations (
    student_id, summary_id, start_offset, end_offset, color, note, block_id
  ) VALUES (
    v_student_id, p_summary_id, p_start_offset, p_end_offset, p_color, p_note, p_block_id
  )
  RETURNING row_to_json(text_annotations.*) INTO v_result;

  RETURN v_result;
END;
$$;

-- Re-apply grant after CREATE OR REPLACE
GRANT EXECUTE ON FUNCTION create_text_annotation TO authenticated;


-- increment_daily_stat — add search_path
CREATE OR REPLACE FUNCTION public.increment_daily_stat(
  p_student_id uuid,
  p_field text,
  p_amount integer DEFAULT 1
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_field = 'reviews_today' THEN
    UPDATE student_stats
      SET reviews_today = COALESCE(reviews_today, 0) + p_amount,
          total_reviews = COALESCE(total_reviews, 0) + p_amount
      WHERE student_id = p_student_id;
  ELSIF p_field = 'sessions_today' THEN
    UPDATE student_stats
      SET sessions_today = COALESCE(sessions_today, 0) + p_amount,
          total_sessions = COALESCE(total_sessions, 0) + p_amount
      WHERE student_id = p_student_id;
  ELSIF p_field = 'correct_streak' THEN
    UPDATE student_stats
      SET correct_streak = COALESCE(correct_streak, 0) + p_amount
      WHERE student_id = p_student_id;
  ELSIF p_field = 'challenges_completed' THEN
    UPDATE student_stats
      SET challenges_completed = COALESCE(challenges_completed, 0) + p_amount
      WHERE student_id = p_student_id;
  ELSE
    RAISE EXCEPTION 'Invalid field: %', p_field;
  END IF;
END;
$$;

-- Re-apply grant after CREATE OR REPLACE
GRANT EXECUTE ON FUNCTION increment_daily_stat TO service_role;


-- refresh_leaderboard_weekly — add search_path
CREATE OR REPLACE FUNCTION public.refresh_leaderboard_weekly()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_weekly;
END;
$$;

-- Re-apply grant after CREATE OR REPLACE
GRANT EXECUTE ON FUNCTION refresh_leaderboard_weekly TO service_role;


-- reset_correct_streak — add search_path
CREATE OR REPLACE FUNCTION public.reset_correct_streak(p_student_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE student_stats SET correct_streak = 0 WHERE student_id = p_student_id;
END;
$$;

-- Re-apply grant after CREATE OR REPLACE
GRANT EXECUTE ON FUNCTION reset_correct_streak TO service_role;


COMMIT;

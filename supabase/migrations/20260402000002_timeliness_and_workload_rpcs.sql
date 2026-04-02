-- ╔══════════════════════════════════════════════════════════════╗
-- ║  FSRS/BKT Calendar Sprint 0 — Timeliness & Workload RPCs  ║
-- ╚══════════════════════════════════════════════════════════════╝
--
-- Two SECURITY DEFINER functions for calendar integration:
--   1. get_student_timeliness_profile — how late a student typically reviews
--   2. get_projected_daily_workload   — projected card count per day
--
-- Schema notes (verified against existing migrations):
--   reviews:       session_id, item_id, created_at (NOT review_date)
--   study_sessions: id, student_id
--   fsrs_states:   flashcard_id (NOT card_id), student_id, due_at, stability

-- ─── RPC 1: get_student_timeliness_profile ──────────────────────

CREATE OR REPLACE FUNCTION get_student_timeliness_profile(p_student_id UUID)
RETURNS TABLE (
  avg_days_late    NUMERIC,
  q1_delay         NUMERIC,
  median_delay     NUMERIC,
  q3_delay         NUMERIC,
  p95_delay        NUMERIC,
  total_review_count BIGINT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH review_gaps AS (
    SELECT
      r.created_at::date - fs.due_at::date AS days_late
    FROM reviews r
    JOIN study_sessions ss ON ss.id = r.session_id
    JOIN fsrs_states fs ON fs.flashcard_id = r.item_id
                       AND fs.student_id = ss.student_id
    WHERE ss.student_id = p_student_id
      AND r.created_at > NOW() - INTERVAL '90 days'
      AND r.created_at IS NOT NULL
      AND fs.due_at IS NOT NULL
  )
  SELECT
    ROUND(AVG(days_late)::numeric, 1),
    PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY days_late),
    PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY days_late),
    PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY days_late),
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY days_late),
    COUNT(*)
  FROM review_gaps;
$$;

REVOKE ALL ON FUNCTION get_student_timeliness_profile(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_student_timeliness_profile(UUID) TO authenticated;

-- ─── RPC 2: get_projected_daily_workload ────────────────────────

CREATE OR REPLACE FUNCTION get_projected_daily_workload(
  p_student_id UUID,
  p_days_ahead INT DEFAULT 90
)
RETURNS TABLE (
  projected_review_date DATE,
  projected_card_count  BIGINT,
  avg_stability_days    NUMERIC,
  earliest_due          TIMESTAMPTZ,
  latest_due            TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH timeliness AS (
    SELECT COALESCE(
      (SELECT ROUND(AVG(r.created_at::date - fs.due_at::date)::numeric, 0)
       FROM reviews r
       JOIN study_sessions ss ON ss.id = r.session_id
       JOIN fsrs_states fs ON fs.flashcard_id = r.item_id
                          AND fs.student_id = ss.student_id
       WHERE ss.student_id = p_student_id
         AND r.created_at > NOW() - INTERVAL '90 days'),
      0
    ) AS avg_days_late
  )
  SELECT
    DATE(fs.due_at + INTERVAL '1 day' * t.avg_days_late) AS projected_review_date,
    COUNT(*) AS projected_card_count,
    ROUND(AVG(fs.stability)::numeric, 1) AS avg_stability_days,
    MIN(fs.due_at) AS earliest_due,
    MAX(fs.due_at) AS latest_due
  FROM fsrs_states fs
  CROSS JOIN timeliness t
  WHERE fs.student_id = p_student_id
    AND fs.due_at > NOW()
    AND fs.due_at < NOW() + (p_days_ahead || ' days')::INTERVAL
  GROUP BY DATE(fs.due_at + INTERVAL '1 day' * t.avg_days_late)
  ORDER BY projected_review_date;
$$;

REVOKE ALL ON FUNCTION get_projected_daily_workload(UUID, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_projected_daily_workload(UUID, INT) TO authenticated;

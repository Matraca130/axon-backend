-- ============================================================
-- Migration: get_course_summary_ids DB function
-- M-1 performance fix: replaces 4 sequential queries
-- (semesters → sections → topics → summaries) with a single
-- 4-table JOIN.
--
-- Usage:
--   SELECT * FROM get_course_summary_ids('course-uuid-here');
--   Returns: table of (id uuid)
--
-- IMPORTANT: Run this in the Supabase SQL Editor.
-- ============================================================

CREATE OR REPLACE FUNCTION get_course_summary_ids(
  p_course_id uuid
)
RETURNS TABLE(id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT DISTINCT s.id
  FROM summaries s
  JOIN topics t   ON s.topic_id    = t.id  AND t.deleted_at  IS NULL
  JOIN sections sec ON t.section_id  = sec.id AND sec.deleted_at IS NULL
  JOIN semesters sem ON sec.semester_id = sem.id AND sem.deleted_at IS NULL
  WHERE sem.course_id = p_course_id
    AND s.deleted_at IS NULL;
$$;

GRANT EXECUTE ON FUNCTION get_course_summary_ids(uuid) TO anon, authenticated;

COMMENT ON FUNCTION get_course_summary_ids IS
  'Resolves course_id → all summary IDs via 4-table JOIN. Single round-trip.';

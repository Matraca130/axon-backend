-- ============================================================
-- Migration: get_institution_summary_ids DB function
-- INC-5 FIX: ingest.ts fallback was calling get_course_summary_ids
-- with p_institution_id parameter, but that function expects p_course_id.
-- This caused the fallback path to always fail silently.
--
-- This new function resolves institution_id → all summary IDs
-- via a 5-table JOIN (courses→semesters→sections→topics→summaries).
--
-- Usage:
--   SELECT * FROM get_institution_summary_ids('institution-uuid-here');
--   Returns: table of (summary_id uuid)
-- ============================================================

CREATE OR REPLACE FUNCTION get_institution_summary_ids(
  p_institution_id uuid
)
RETURNS TABLE(summary_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT DISTINCT s.id AS summary_id
  FROM summaries s
  JOIN topics t     ON s.topic_id      = t.id   AND t.deleted_at   IS NULL
  JOIN sections sec ON t.section_id    = sec.id AND sec.deleted_at IS NULL
  JOIN semesters sem ON sec.semester_id = sem.id AND sem.deleted_at IS NULL
  JOIN courses c    ON sem.course_id   = c.id   AND c.deleted_at   IS NULL
  WHERE c.institution_id = p_institution_id
    AND s.deleted_at IS NULL;
$$;

GRANT EXECUTE ON FUNCTION get_institution_summary_ids(uuid) TO anon, authenticated;

COMMENT ON FUNCTION get_institution_summary_ids IS
  'Resolves institution_id → all summary IDs via 5-table JOIN. Used by ingest.ts fallback.';

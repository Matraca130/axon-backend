-- ============================================================
-- Migration: search_keywords_by_institution RPC
-- Date: 2026-03-05
--
-- Problem: keyword-search.ts calls this RPC but it was never created.
-- The endpoint returns 500 on every call.
--
-- Solution: Create the function using denormalized institution_id
-- on summaries (added by 20260304_06_denorm_institution_id.sql).
-- Only 1 JOIN needed (keywords → summaries).
--
-- Signature matches keyword-search.ts expectations:
--   search_keywords_by_institution(
--     p_institution_id, p_query,
--     p_exclude_summary_id, p_course_id, p_limit
--   )
--   Returns: (id, name, summary_id, definition, summary_title)
--
-- Performance: Uses pg_trgm index on keywords.name (created by
-- 20260227_05_trigram_indexes.sql) for fast ILIKE matching.
-- ============================================================

CREATE OR REPLACE FUNCTION search_keywords_by_institution(
  p_institution_id UUID,
  p_query TEXT,
  p_exclude_summary_id UUID DEFAULT NULL,
  p_course_id UUID DEFAULT NULL,
  p_limit INT DEFAULT 15
)
RETURNS TABLE (
  id UUID,
  name TEXT,
  summary_id UUID,
  definition TEXT,
  summary_title TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT
    k.id,
    k.name,
    k.summary_id,
    k.definition,
    s.title AS summary_title
  FROM keywords k
  JOIN summaries s ON s.id = k.summary_id
  WHERE s.institution_id = p_institution_id
    AND s.deleted_at IS NULL
    AND s.is_active = TRUE
    AND k.deleted_at IS NULL
    AND k.name ILIKE '%' || p_query || '%'
    AND (p_exclude_summary_id IS NULL OR k.summary_id != p_exclude_summary_id)
    AND (
      p_course_id IS NULL
      OR s.id IN (
        SELECT sub_s.id
        FROM summaries sub_s
        JOIN topics t    ON sub_s.topic_id   = t.id
        JOIN sections sec ON t.section_id    = sec.id
        JOIN semesters sem ON sec.semester_id = sem.id
        WHERE sem.course_id = p_course_id
          AND sub_s.deleted_at IS NULL
      )
    )
  ORDER BY
    -- Exact prefix match ranked first
    CASE WHEN k.name ILIKE p_query || '%' THEN 0 ELSE 1 END,
    k.name
  LIMIT LEAST(p_limit, 30);
$$;

GRANT EXECUTE ON FUNCTION search_keywords_by_institution(
  UUID, TEXT, UUID, UUID, INT
) TO anon, authenticated;

COMMENT ON FUNCTION search_keywords_by_institution IS
  'Cross-summary keyword search scoped to institution. Used by GET /keyword-search endpoint.';

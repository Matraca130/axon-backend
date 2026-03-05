-- ============================================================
-- Migration: Add published filter to search_keywords_by_institution
-- Date: 2026-03-06
--
-- Problem: RPC returns keywords from draft summaries.
-- Students calling GET /keyword-search see unpublished content.
-- Professors can find and connect to draft keywords, creating
-- connections that break student navigation.
--
-- Fix: Add s.status = 'published' to WHERE clause.
-- Keyword search ONLY returns keywords from published summaries.
-- Professors creating connections from drafts can still find
-- published keywords to connect to, but not other drafts.
--
-- Idempotent: CREATE OR REPLACE.
-- Backward compatible: stricter filter, no schema change.
-- Rollback: Re-run 20260305_06 (restores version without filter).
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
    AND s.status = 'published'
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
    CASE WHEN k.name ILIKE p_query || '%' THEN 0 ELSE 1 END,
    k.name
  LIMIT LEAST(p_limit, 30);
$$;

-- Grant already exists but repeating is idempotent
GRANT EXECUTE ON FUNCTION search_keywords_by_institution(
  UUID, TEXT, UUID, UUID, INT
) TO anon, authenticated;

COMMENT ON FUNCTION search_keywords_by_institution IS
  'Cross-summary keyword search scoped to institution. Only returns keywords from published summaries.';

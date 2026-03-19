-- ============================================================
-- Migration: Simplify Denormalized RPCs
-- Date: 2026-03-19
-- Purpose: Leverage summaries.institution_id (denormalized in
--          20260304_06) to eliminate unnecessary JOINs.
--
-- 1. get_institution_summary_ids: 5-JOIN → direct column lookup
-- 2. resolve_parent_institution('summaries'): 4-JOIN → direct column
--
-- Both functions are SECURITY DEFINER, signatures unchanged.
-- ============================================================

-- 1. Simplified get_institution_summary_ids
--    Before: 5-table JOIN (summaries→topics→sections→semesters→courses)
--    After:  Direct filter on summaries.institution_id
CREATE OR REPLACE FUNCTION get_institution_summary_ids(
  p_institution_id uuid
)
RETURNS TABLE(summary_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.id AS summary_id
  FROM summaries s
  WHERE s.institution_id = p_institution_id
    AND s.deleted_at IS NULL;
$$;

COMMENT ON FUNCTION get_institution_summary_ids IS
  'Resolves institution_id → all summary IDs via denormalized column. Simplified from 5-JOIN.';

-- 2. Simplified resolve_parent_institution for 'summaries' case
--    The full function handles 14+ tables via CASE. We only optimize
--    the 'summaries' branch to use the denormalized column directly
--    instead of the 4-hop JOIN chain.
CREATE OR REPLACE FUNCTION resolve_parent_institution(
  p_table TEXT,
  p_id    UUID
)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_institution_id UUID;
BEGIN
  IF p_table IS NULL OR p_id IS NULL THEN
    RETURN NULL;
  END IF;

  CASE p_table

    -- Direct: courses have institution_id
    WHEN 'courses' THEN
      SELECT c.institution_id INTO v_institution_id
      FROM courses c WHERE c.id = p_id;

    -- 1 hop: semesters -> courses
    WHEN 'semesters' THEN
      SELECT c.institution_id INTO v_institution_id
      FROM semesters s
      JOIN courses c ON c.id = s.course_id
      WHERE s.id = p_id;

    -- 2 hops: sections -> semesters -> courses
    WHEN 'sections' THEN
      SELECT c.institution_id INTO v_institution_id
      FROM sections sec
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE sec.id = p_id;

    -- 3 hops: topics -> sections -> semesters -> courses
    WHEN 'topics' THEN
      SELECT c.institution_id INTO v_institution_id
      FROM topics t
      JOIN sections sec ON sec.id = t.section_id
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE t.id = p_id;

    -- OPTIMIZED: summaries have denormalized institution_id (0 JOINs)
    WHEN 'summaries' THEN
      SELECT sm.institution_id INTO v_institution_id
      FROM summaries sm
      WHERE sm.id = p_id;

    -- chunks -> summaries (1 JOIN via denormalized column)
    WHEN 'chunks' THEN
      SELECT sm.institution_id INTO v_institution_id
      FROM chunks ch
      JOIN summaries sm ON sm.id = ch.summary_id
      WHERE ch.id = p_id;

    -- summary_blocks -> summaries (1 JOIN via denormalized column)
    WHEN 'summary_blocks' THEN
      SELECT sm.institution_id INTO v_institution_id
      FROM summary_blocks sb
      JOIN summaries sm ON sm.id = sb.summary_id
      WHERE sb.id = p_id;

    -- keywords -> summaries (1 JOIN via denormalized column)
    WHEN 'keywords' THEN
      SELECT sm.institution_id INTO v_institution_id
      FROM keywords k
      JOIN summaries sm ON sm.id = k.summary_id
      WHERE k.id = p_id;

    -- subtopics -> keywords -> summaries (2 JOINs via denormalized column)
    WHEN 'subtopics' THEN
      SELECT sm.institution_id INTO v_institution_id
      FROM subtopics st
      JOIN keywords k ON k.id = st.keyword_id
      JOIN summaries sm ON sm.id = k.summary_id
      WHERE st.id = p_id;

    -- keyword_connections -> keywords -> summaries (2 JOINs via denormalized column)
    WHEN 'keyword_connections' THEN
      SELECT sm.institution_id INTO v_institution_id
      FROM keyword_connections kc
      JOIN keywords k ON k.id = kc.keyword_a_id
      JOIN summaries sm ON sm.id = k.summary_id
      WHERE kc.id = p_id;

    -- kw_prof_notes -> keywords -> summaries (2 JOINs via denormalized column)
    WHEN 'kw_prof_notes' THEN
      SELECT sm.institution_id INTO v_institution_id
      FROM kw_prof_notes pn
      JOIN keywords k ON k.id = pn.keyword_id
      JOIN summaries sm ON sm.id = k.summary_id
      WHERE pn.id = p_id;

    -- videos -> summaries (1 JOIN via denormalized column)
    WHEN 'videos' THEN
      SELECT sm.institution_id INTO v_institution_id
      FROM videos v
      JOIN summaries sm ON sm.id = v.summary_id
      WHERE v.id = p_id;

    -- models_3d -> topics -> sections -> semesters -> courses (4 hops, no shortcut)
    WHEN 'models_3d' THEN
      SELECT c.institution_id INTO v_institution_id
      FROM models_3d m
      JOIN topics t ON t.id = m.topic_id
      JOIN sections sec ON sec.id = t.section_id
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE m.id = p_id;

    -- model_3d_pins -> models_3d -> topics -> ... -> courses (5 hops)
    WHEN 'model_3d_pins' THEN
      SELECT c.institution_id INTO v_institution_id
      FROM model_3d_pins mp
      JOIN models_3d m ON m.id = mp.model_id
      JOIN topics t ON t.id = m.topic_id
      JOIN sections sec ON sec.id = t.section_id
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE mp.id = p_id;

    -- Unknown table: fail-closed
    ELSE
      RETURN NULL;

  END CASE;

  RETURN v_institution_id;
END;
$$;

COMMENT ON FUNCTION resolve_parent_institution IS
  'Resolves any content row to its institution_id. Optimized: summaries+descendants use denormalized institution_id (fewer JOINs).';

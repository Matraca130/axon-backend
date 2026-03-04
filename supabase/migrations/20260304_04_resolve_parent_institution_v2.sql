-- ============================================================
-- Migration: resolve_parent_institution() v2 — Add missing tables
-- Date: 2026-03-04
-- Fixes: A-10 (3 tables missing from Phase 4 RPC)
--
-- New CASE branches:
--   videos         → summary_id → summaries → ... → courses  (5 hops)
--   models_3d      → topic_id → topics → ... → courses       (4 hops)
--   model_3d_pins  → model_id → models_3d → topic_id → ...   (5 hops)
--
-- NOT added (by design):
--   study_plans      → course_id is NULLABLE, table is user-scoped
--   study_plan_tasks → parent study_plans is user-scoped
--   These are handled by skipping institution check in TypeScript.
-- ============================================================

CREATE OR REPLACE FUNCTION resolve_parent_institution(
  p_table TEXT,
  p_id    UUID
)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
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

    -- 1 hop: semesters → courses
    WHEN 'semesters' THEN
      SELECT c.institution_id INTO v_institution_id
      FROM semesters s
      JOIN courses c ON c.id = s.course_id
      WHERE s.id = p_id;

    -- 2 hops: sections → semesters → courses
    WHEN 'sections' THEN
      SELECT c.institution_id INTO v_institution_id
      FROM sections sec
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE sec.id = p_id;

    -- 3 hops: topics → sections → semesters → courses
    WHEN 'topics' THEN
      SELECT c.institution_id INTO v_institution_id
      FROM topics t
      JOIN sections sec ON sec.id = t.section_id
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE t.id = p_id;

    -- 4 hops: summaries → topics → ... → courses
    WHEN 'summaries' THEN
      SELECT c.institution_id INTO v_institution_id
      FROM summaries sm
      JOIN topics t ON t.id = sm.topic_id
      JOIN sections sec ON sec.id = t.section_id
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE sm.id = p_id;

    -- 5 hops: chunks → summaries → ... → courses
    WHEN 'chunks' THEN
      SELECT c.institution_id INTO v_institution_id
      FROM chunks ch
      JOIN summaries sm ON sm.id = ch.summary_id
      JOIN topics t ON t.id = sm.topic_id
      JOIN sections sec ON sec.id = t.section_id
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE ch.id = p_id;

    -- 5 hops: summary_blocks → summaries → ... → courses
    WHEN 'summary_blocks' THEN
      SELECT c.institution_id INTO v_institution_id
      FROM summary_blocks sb
      JOIN summaries sm ON sm.id = sb.summary_id
      JOIN topics t ON t.id = sm.topic_id
      JOIN sections sec ON sec.id = t.section_id
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE sb.id = p_id;

    -- 5 hops: keywords → summaries → ... → courses
    WHEN 'keywords' THEN
      SELECT c.institution_id INTO v_institution_id
      FROM keywords k
      JOIN summaries sm ON sm.id = k.summary_id
      JOIN topics t ON t.id = sm.topic_id
      JOIN sections sec ON sec.id = t.section_id
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE k.id = p_id;

    -- 6 hops: subtopics → keywords → summaries → ... → courses
    WHEN 'subtopics' THEN
      SELECT c.institution_id INTO v_institution_id
      FROM subtopics st
      JOIN keywords k ON k.id = st.keyword_id
      JOIN summaries sm ON sm.id = k.summary_id
      JOIN topics t ON t.id = sm.topic_id
      JOIN sections sec ON sec.id = t.section_id
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE st.id = p_id;

    -- 6 hops: keyword_connections → keywords → summaries → ... → courses
    WHEN 'keyword_connections' THEN
      SELECT c.institution_id INTO v_institution_id
      FROM keyword_connections kc
      JOIN keywords k ON k.id = kc.keyword_a_id
      JOIN summaries sm ON sm.id = k.summary_id
      JOIN topics t ON t.id = sm.topic_id
      JOIN sections sec ON sec.id = t.section_id
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE kc.id = p_id;

    -- 6 hops: kw_prof_notes → keywords → summaries → ... → courses
    WHEN 'kw_prof_notes' THEN
      SELECT c.institution_id INTO v_institution_id
      FROM kw_prof_notes pn
      JOIN keywords k ON k.id = pn.keyword_id
      JOIN summaries sm ON sm.id = k.summary_id
      JOIN topics t ON t.id = sm.topic_id
      JOIN sections sec ON sec.id = t.section_id
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE pn.id = p_id;

    -- A-10 FIX: videos → summary_id → summaries → ... → courses (5 hops)
    WHEN 'videos' THEN
      SELECT c.institution_id INTO v_institution_id
      FROM videos v
      JOIN summaries sm ON sm.id = v.summary_id
      JOIN topics t ON t.id = sm.topic_id
      JOIN sections sec ON sec.id = t.section_id
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE v.id = p_id;

    -- A-10 FIX: models_3d → topic_id → topics → ... → courses (4 hops)
    WHEN 'models_3d' THEN
      SELECT c.institution_id INTO v_institution_id
      FROM models_3d m
      JOIN topics t ON t.id = m.topic_id
      JOIN sections sec ON sec.id = t.section_id
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE m.id = p_id;

    -- A-10 FIX: model_3d_pins → model_id → models_3d → topic_id → ... → courses (5 hops)
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

-- Grant is idempotent (function signature unchanged)
GRANT EXECUTE ON FUNCTION resolve_parent_institution(TEXT, UUID) TO authenticated;

COMMENT ON FUNCTION resolve_parent_institution IS
  'H-5+A-10 fix: Resolves any content row to its institution_id via FK chain. Now covers 14 tables. SECURITY DEFINER, fail-closed.';

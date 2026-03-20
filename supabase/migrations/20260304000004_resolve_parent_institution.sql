-- ============================================================
-- Migration: resolve_parent_institution() RPC
-- Date: 2026-03-04
-- Issue: H-5 (content tables without institution scoping)
--
-- Given any content table name + row UUID, walks the FK hierarchy
-- to return the institution_id that owns the resource.
--
-- Hierarchy chains:
--   courses         → courses.institution_id (direct)
--   semesters       → courses
--   sections        → semesters → courses
--   topics          → sections → semesters → courses
--   summaries       → topics → sections → semesters → courses
--   chunks          → summaries → ... → courses
--   summary_blocks  → summaries → ... → courses
--   keywords        → summaries → ... → courses
--   subtopics       → keywords → summaries → ... → courses
--   keyword_connections → keywords → summaries → ... → courses
--   kw_prof_notes   → keywords → summaries → ... → courses
--
-- Security:
--   SECURITY DEFINER — bypasses RLS to ensure consistent resolution
--   regardless of the caller's RLS policies.
--   Returns NULL for unknown tables (fail-closed).
--
-- Performance:
--   Each CASE branch uses FK indexes. Deepest chain (subtopics)
--   is 7 JOINs, all indexed. Expected: <5ms.
--   No deleted_at filters: works for deleted items (needed for RESTORE).
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

    -- Unknown table: fail-closed
    ELSE
      RETURN NULL;

  END CASE;

  RETURN v_institution_id;
END;
$$;

GRANT EXECUTE ON FUNCTION resolve_parent_institution(TEXT, UUID) TO authenticated;

COMMENT ON FUNCTION resolve_parent_institution IS
  'H-5 fix: Resolves any content row to its institution_id via FK chain. SECURITY DEFINER, fail-closed.';

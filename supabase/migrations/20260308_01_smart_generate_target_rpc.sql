-- ============================================================
-- Migration: Smart Generate Target RPC (Fase 8A)
-- Date: 2026-03-08
-- Purpose: Find the best keyword+summary to generate AI content
--          for a student, based on concept-level NeedScore.
--
-- Unlike get_study_queue() which works at the FLASHCARD level
-- (card scheduling via FSRS), this RPC works at the KEYWORD level
-- (concept mastery via BKT). The question is different:
--   study_queue:  "Which card should I review next?"
--   smart_target: "Which concept should I study next?"
--
-- Algorithm:
--   concept_need_score = 1 - COALESCE(p_know, 0)
--   - New concepts (no BKT state): score = 1.0 (highest priority)
--   - Low mastery (p_know < 0.30):  score > 0.70
--   - High mastery (p_know > 0.80): score < 0.20
--
-- Keyword → Subtopic link:
--   BKT tracks mastery per subtopic, but we select keywords.
--   The link is: keyword → flashcards(keyword_id) → subtopic_id → bkt_states.
--   If a keyword has no flashcards (or none with subtopic_id), p_know = 0.
--
-- Institution scoping:
--   p_institution_id is optional. If NULL, scopes to ALL institutions
--   the student has active memberships in.
--
-- Returns TOP 5 targets (not 1) so TypeScript can do dedup checks
-- (avoid generating content for a concept that was recently generated).
-- See D1, D2, D3 in the architectural plan.
--
-- Tiebreaker: keyword.created_at ASC ensures deterministic ordering
-- when multiple keywords have the same score (E1 fix: new students
-- see content in the order the professor defined).
-- ============================================================

CREATE OR REPLACE FUNCTION get_smart_generate_target(
  p_student_id UUID,
  p_institution_id UUID DEFAULT NULL
)
RETURNS TABLE (
  subtopic_id    UUID,
  subtopic_name  TEXT,
  keyword_id     UUID,
  keyword_name   TEXT,
  keyword_def    TEXT,
  summary_id     UUID,
  summary_title  TEXT,
  topic_id       UUID,
  p_know         NUMERIC,
  need_score     NUMERIC,
  primary_reason TEXT
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  RETURN QUERY
  WITH
  -- Step 1: Resolve student's accessible institutions via memberships.
  -- If p_institution_id is provided, filter to that institution only.
  student_institutions AS (
    SELECT m.institution_id
    FROM memberships m
    WHERE m.user_id = p_student_id
      AND m.is_active = true
      AND (p_institution_id IS NULL OR m.institution_id = p_institution_id)
  ),

  -- Step 2: Resolve active courses within those institutions.
  student_courses AS (
    SELECT c.id
    FROM courses c
    WHERE c.institution_id IN (SELECT institution_id FROM student_institutions)
      AND c.is_active = true
  ),

  -- Step 3: Walk hierarchy down to summaries.
  -- Same proven pattern as get_study_queue() (C-2 fix).
  accessible_summaries AS (
    SELECT s.id, s.title, s.topic_id
    FROM summaries s
    JOIN topics t ON t.id = s.topic_id AND t.deleted_at IS NULL
    JOIN sections sec ON sec.id = t.section_id AND sec.deleted_at IS NULL
    JOIN semesters sem ON sem.id = sec.semester_id AND sem.deleted_at IS NULL
    WHERE s.deleted_at IS NULL
      AND sem.course_id IN (SELECT id FROM student_courses)
  ),

  -- Step 4: Get all active keywords from accessible summaries.
  -- Keywords are the generation target (generate.ts needs keyword_id).
  keyword_targets AS (
    SELECT
      k.id AS kw_id,
      k.name AS kw_name,
      k.definition AS kw_def,
      k.created_at AS kw_created_at,
      asumm.id AS summ_id,
      asumm.title AS summ_title,
      asumm.topic_id AS summ_topic_id
    FROM accessible_summaries asumm
    JOIN keywords k ON k.summary_id = asumm.id AND k.deleted_at IS NULL
  ),

  -- Step 5: For each keyword, find ONE associated subtopic via flashcards.
  -- This is the keyword → BKT bridge.
  -- LATERAL + LIMIT 1 is efficient (stops after first match).
  -- If no flashcard exists for this keyword, linked_subtopic_id = NULL → p_know = 0.
  keywords_with_subtopic AS (
    SELECT
      kt.*,
      kw_sub.subtopic_id AS linked_subtopic_id,
      st.name AS linked_subtopic_name
    FROM keyword_targets kt
    LEFT JOIN LATERAL (
      SELECT f.subtopic_id
      FROM flashcards f
      WHERE f.keyword_id = kt.kw_id
        AND f.subtopic_id IS NOT NULL
        AND f.deleted_at IS NULL
      LIMIT 1
    ) kw_sub ON TRUE
    LEFT JOIN subtopics st ON st.id = kw_sub.subtopic_id
  ),

  -- Step 6: Join with BKT states for concept mastery.
  -- concept_need_score = 1 - p_know (continuous, no arbitrary thresholds).
  -- primary_reason is categorical (for logging and prompt context).
  keywords_scored AS (
    SELECT
      kws.*,
      COALESCE(bkt.p_know, 0) AS bkt_p_know,
      ROUND((1.0 - COALESCE(bkt.p_know, 0))::NUMERIC, 3) AS computed_need_score,
      CASE
        WHEN bkt.p_know IS NULL THEN 'new_concept'
        WHEN bkt.p_know < 0.30 THEN 'low_mastery'
        WHEN bkt.p_know < 0.50 THEN 'needs_review'
        WHEN bkt.p_know < 0.80 THEN 'moderate_mastery'
        ELSE 'reinforcement'
      END AS computed_reason
    FROM keywords_with_subtopic kws
    LEFT JOIN bkt_states bkt
      ON bkt.subtopic_id = kws.linked_subtopic_id
      AND bkt.student_id = p_student_id
  )

  -- Final: Return top 5 targets ordered by need.
  -- E1 tiebreaker: kw_created_at ASC = course content order.
  SELECT
    ks.linked_subtopic_id   AS subtopic_id,
    ks.linked_subtopic_name AS subtopic_name,
    ks.kw_id                AS keyword_id,
    ks.kw_name              AS keyword_name,
    ks.kw_def               AS keyword_def,
    ks.summ_id              AS summary_id,
    ks.summ_title           AS summary_title,
    ks.summ_topic_id        AS topic_id,
    ROUND(ks.bkt_p_know::NUMERIC, 3) AS p_know,
    ks.computed_need_score   AS need_score,
    ks.computed_reason       AS primary_reason
  FROM keywords_scored ks
  ORDER BY
    ks.computed_need_score DESC,
    ks.kw_created_at ASC
  LIMIT 5;
END;
$$;

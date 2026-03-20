-- ============================================================
-- Migration: Smart Generate Target — Subtopic-Centric (Fase 8F)
-- Date: 2026-03-13
-- Purpose: Replace LATERAL flashcards with direct JOIN subtopics
--          in get_smart_generate_target() for reliable subtopic
--          resolution.
--
-- Problem with v1 (LATERAL flashcards):
--   subtopic_id was resolved by finding a flashcard that references
--   a subtopic. Keywords without such flashcards got NULL subtopic_id
--   even when subtopics existed — breaking subtopic-level dedup.
--
-- Solution (v2 — subtopic-centric):
--   JOIN subtopics directly via subtopics.keyword_id.
--   When multiple subtopics exist per keyword, pick the one with
--   lowest BKT mastery (or oldest if no BKT state).
--   This guarantees subtopic_id is populated whenever subtopics exist.
--
-- Backward compatibility:
--   Same function signature, same RETURNS TABLE columns.
--   Output differs only in that subtopic_id is now reliably populated.
--
-- Depends on: 20260313_01_smart_target_summary_scope.sql
-- ============================================================

CREATE OR REPLACE FUNCTION get_smart_generate_target(
  p_student_id UUID,
  p_institution_id UUID DEFAULT NULL,
  p_summary_id UUID DEFAULT NULL,
  p_limit INT DEFAULT 5
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
  accessible_summaries AS (
    SELECT s.id, s.title, s.topic_id
    FROM summaries s
    JOIN topics t ON t.id = s.topic_id AND t.deleted_at IS NULL
    JOIN sections sec ON sec.id = t.section_id AND sec.deleted_at IS NULL
    JOIN semesters sem ON sem.id = sec.semester_id AND sem.deleted_at IS NULL
    WHERE s.deleted_at IS NULL
      AND sem.course_id IN (SELECT id FROM student_courses)
      AND (p_summary_id IS NULL OR s.id = p_summary_id)
  ),

  -- Step 4: Get all active keywords from accessible summaries.
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

  -- Step 5 (v2): For each keyword, find the BEST subtopic directly.
  -- Joins subtopics table via keyword_id (not via flashcards).
  -- When multiple subtopics exist, picks the one with lowest BKT mastery
  -- (prioritizes concepts the student needs most).
  -- Falls back to oldest subtopic if no BKT state exists.
  keywords_with_subtopic AS (
    SELECT DISTINCT ON (kt.kw_id)
      kt.*,
      st.id   AS linked_subtopic_id,
      st.name AS linked_subtopic_name,
      COALESCE(bkt_sub.p_know, 0) AS sub_p_know
    FROM keyword_targets kt
    LEFT JOIN subtopics st
      ON st.keyword_id = kt.kw_id
      AND st.deleted_at IS NULL
    LEFT JOIN bkt_states bkt_sub
      ON bkt_sub.subtopic_id = st.id
      AND bkt_sub.student_id = p_student_id
    ORDER BY
      kt.kw_id,
      COALESCE(bkt_sub.p_know, 0) ASC,  -- lowest mastery first
      st.created_at ASC                  -- oldest as tiebreaker
  ),

  -- Step 6: Score keywords by BKT mastery for final ranking.
  keywords_scored AS (
    SELECT
      kws.*,
      COALESCE(
        CASE WHEN kws.linked_subtopic_id IS NOT NULL
          THEN kws.sub_p_know
          ELSE 0
        END,
        0
      ) AS bkt_p_know,
      ROUND(
        (1.0 - COALESCE(
          CASE WHEN kws.linked_subtopic_id IS NOT NULL
            THEN kws.sub_p_know
            ELSE 0
          END,
          0
        ))::NUMERIC,
        3
      ) AS computed_need_score,
      CASE
        WHEN kws.linked_subtopic_id IS NULL THEN 'new_concept'
        WHEN kws.sub_p_know IS NULL THEN 'new_concept'
        WHEN kws.sub_p_know < 0.30 THEN 'low_mastery'
        WHEN kws.sub_p_know < 0.50 THEN 'needs_review'
        WHEN kws.sub_p_know < 0.80 THEN 'moderate_mastery'
        ELSE 'reinforcement'
      END AS computed_reason
    FROM keywords_with_subtopic kws
  )

  -- Final: Return top targets ordered by need.
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
  LIMIT LEAST(p_limit, 20);
END;
$$;

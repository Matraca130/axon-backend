-- ============================================================
-- Migration: Smart Generate Target — Summary Scope + Limit (Fase 8E)
-- Date: 2026-03-13
-- Purpose: Add p_summary_id and p_limit parameters to
--          get_smart_generate_target() for flexible scoping.
--
-- Changes:
--   p_summary_id (UUID, DEFAULT NULL):
--     When provided, only keywords from that specific summary
--     are considered as targets. When NULL (default), the
--     existing global behavior is preserved.
--
--   p_limit (INT, DEFAULT 5):
--     Allows the caller to request more than 5 targets.
--     Capped at 20 for safety. Default 5 preserves existing
--     behavior for all current callers.
--
-- Backward compatibility:
--   Both new params have DEFAULT values. All existing RPC calls
--   (which pass only p_student_id and p_institution_id) continue
--   working identically. The function signature is replaced
--   via DROP + CREATE to avoid PostgreSQL overload ambiguity.
--
-- Depends on: 20260308_01_smart_generate_target_rpc.sql
-- ============================================================

-- Drop the old 2-param signature to avoid overloading.
-- This is safe because CREATE OR REPLACE with new params
-- would create a SECOND function (PostgreSQL overloading),
-- not replace the original.
DROP FUNCTION IF EXISTS get_smart_generate_target(UUID, UUID);

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
  -- Fase 8E: Added p_summary_id filter. When NULL, all summaries match.
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

  -- Step 5: For each keyword, find ONE associated subtopic via flashcards.
  -- A3 FIX: ORDER BY f.created_at ASC for deterministic pick.
  -- A4 FIX: Uses idx_flashcards_keyword_subtopic partial index.
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
      ORDER BY f.created_at ASC
      LIMIT 1
    ) kw_sub ON TRUE
    LEFT JOIN subtopics st ON st.id = kw_sub.subtopic_id
  ),

  -- Step 6: Join with BKT states for concept mastery.
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

  -- Final: Return top targets ordered by need.
  -- E1 tiebreaker: kw_created_at ASC = course content order.
  -- Fase 8E: LIMIT uses p_limit capped at 20.
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

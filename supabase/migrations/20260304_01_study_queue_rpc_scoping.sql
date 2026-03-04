-- ============================================================
-- Migration: Study Queue RPC — Institution Scoping (C-2 Fix)
-- Date: 2026-03-04
-- Purpose: Scope flashcards in get_study_queue() to the student's
--          accessible institutions when course_id is NULL.
--
-- BUG: When p_course_id was NULL, the RPC selected ALL active
-- flashcards from ALL institutions with zero filtering.
-- The JS fallback was fixed (U-1 in PR #8) but the SQL RPC
-- (primary path, used >99% of the time) was not.
--
-- FIX: New CTEs resolve the student's institutions via memberships,
-- then their courses. allowed_summaries now handles both cases.
-- active_cards ALWAYS filters by allowed_summaries.
--
-- Performance note:
--   The new CTEs add 2 small lookups (memberships + courses) that
--   are indexed and return few rows. The JOIN chain in
--   allowed_summaries is the same as before. Net impact: negligible.
--   For the p_course_id IS NOT NULL case, student_institutions and
--   student_courses CTEs are not referenced and PostgreSQL will
--   optimize them away (CTE inlining in PG 12+).
-- ============================================================

-- Must drop first: recreating function body
DROP FUNCTION IF EXISTS get_study_queue(uuid, uuid, integer, boolean);

CREATE OR REPLACE FUNCTION get_study_queue(
  p_student_id UUID,
  p_course_id UUID DEFAULT NULL,
  p_limit INTEGER DEFAULT 20,
  p_include_future BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
  flashcard_id UUID,
  summary_id UUID,
  keyword_id UUID,
  subtopic_id UUID,
  front TEXT,
  back TEXT,
  front_image_url TEXT,
  back_image_url TEXT,
  need_score NUMERIC,
  retention NUMERIC,
  mastery_color TEXT,
  p_know NUMERIC,
  fsrs_state TEXT,
  due_at TIMESTAMPTZ,
  stability NUMERIC,
  difficulty NUMERIC,
  is_new BOOLEAN,
  total_count BIGINT
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
  v_grace_days NUMERIC := 1.0;
BEGIN
  RETURN QUERY
  WITH
  -- C-2 FIX: Resolve student's accessible institutions via active memberships.
  -- Only used when p_course_id IS NULL (PostgreSQL optimizes away otherwise).
  student_institutions AS (
    SELECT m.institution_id
    FROM memberships m
    WHERE m.user_id = p_student_id
      AND m.is_active = true
  ),

  -- C-2 FIX: Resolve all active courses the student can access.
  student_courses AS (
    SELECT c.id
    FROM courses c
    WHERE c.institution_id IN (SELECT institution_id FROM student_institutions)
      AND c.is_active = true
  ),

  -- Step 1: Resolve allowed summary IDs.
  -- C-2 FIX: Now handles BOTH cases:
  --   - p_course_id IS NOT NULL → scope to that specific course
  --   - p_course_id IS NULL     → scope to ALL student's accessible courses
  -- Previously, p_course_id IS NULL meant NO filtering at all.
  allowed_summaries AS (
    SELECT s.id
    FROM summaries s
    JOIN topics t ON t.id = s.topic_id AND t.deleted_at IS NULL
    JOIN sections sec ON sec.id = t.section_id AND sec.deleted_at IS NULL
    JOIN semesters sem ON sem.id = sec.semester_id AND sem.deleted_at IS NULL
    WHERE s.deleted_at IS NULL
      AND (
        -- Case 1: specific course filter
        (p_course_id IS NOT NULL AND sem.course_id = p_course_id)
        OR
        -- Case 2: all courses the student has access to (C-2 FIX)
        (p_course_id IS NULL AND sem.course_id IN (SELECT id FROM student_courses))
      )
  ),

  -- Step 2: Get active flashcards.
  -- C-2 FIX: ALWAYS filtered by allowed_summaries now.
  -- Before: had `p_course_id IS NULL OR ...` which bypassed all filtering.
  active_cards AS (
    SELECT
      f.id,
      f.summary_id,
      f.keyword_id,
      f.subtopic_id,
      f.front,
      f.back,
      f.front_image_url,
      f.back_image_url
    FROM flashcards f
    WHERE f.is_active = true
      AND f.deleted_at IS NULL
      AND f.summary_id IN (SELECT id FROM allowed_summaries)
  ),

  -- Step 3: Join with FSRS states for this student
  cards_with_fsrs AS (
    SELECT
      ac.*,
      fs.stability AS fsrs_stability,
      fs.difficulty AS fsrs_difficulty,
      fs.due_at AS fsrs_due_at,
      fs.last_review_at AS fsrs_last_review_at,
      fs.reps AS fsrs_reps,
      fs.lapses AS fsrs_lapses,
      fs.state AS fsrs_state_val,
      (fs.flashcard_id IS NULL) AS card_is_new
    FROM active_cards ac
    LEFT JOIN fsrs_states fs
      ON fs.flashcard_id = ac.id
      AND fs.student_id = p_student_id
    WHERE
      p_include_future
      OR fs.flashcard_id IS NULL
      OR fs.due_at <= v_now
  ),

  -- Step 4: Join with BKT states for mastery + calculate scores
  cards_with_scores AS (
    SELECT
      c.*,
      COALESCE(bkt.p_know, 0) AS bkt_p_know,

      -- NeedScore calculation (v4.2)
      (
        0.40 * CASE
          WHEN c.fsrs_due_at IS NULL THEN 1.0
          WHEN v_now > c.fsrs_due_at THEN
            1.0 - EXP(
              -EXTRACT(EPOCH FROM (v_now - c.fsrs_due_at)) / 86400.0 / v_grace_days
            )
          ELSE 0.0
        END
        +
        0.30 * (1.0 - COALESCE(bkt.p_know, 0))
        +
        0.20 * LEAST(1.0,
          COALESCE(c.fsrs_lapses, 0)::NUMERIC
          / GREATEST(1, COALESCE(c.fsrs_reps, 0) + COALESCE(c.fsrs_lapses, 0) + 1)::NUMERIC
        )
        +
        0.10 * CASE WHEN COALESCE(c.fsrs_state_val, 'new') = 'new' THEN 1.0 ELSE 0.0 END
      ) AS computed_need_score,

      -- Retention calculation (forgetting curve)
      CASE
        WHEN c.fsrs_last_review_at IS NULL OR COALESCE(c.fsrs_stability, 0) <= 0 THEN 0.0
        ELSE GREATEST(0, LEAST(1.0,
          EXP(
            -EXTRACT(EPOCH FROM (v_now - c.fsrs_last_review_at)) / 86400.0
            / COALESCE(c.fsrs_stability, 1)
          )
        ))
      END AS computed_retention,

      -- Mastery color
      CASE
        WHEN COALESCE(bkt.p_know, 0) < 0 THEN 'gray'
        WHEN COALESCE(bkt.p_know, 0) >= 0.80 THEN 'green'
        WHEN COALESCE(bkt.p_know, 0) >= 0.50 THEN 'yellow'
        ELSE 'red'
      END AS computed_mastery_color

    FROM cards_with_fsrs c
    LEFT JOIN bkt_states bkt
      ON bkt.subtopic_id = c.subtopic_id
      AND bkt.student_id = p_student_id
  )

  -- Final: select, sort by NeedScore DESC, limit
  -- S-3b: COUNT(*) OVER() gives total matching rows before LIMIT
  SELECT
    cs.id AS flashcard_id,
    cs.summary_id,
    cs.keyword_id,
    cs.subtopic_id,
    cs.front,
    cs.back,
    cs.front_image_url,
    cs.back_image_url,
    ROUND(cs.computed_need_score::NUMERIC, 3) AS need_score,
    ROUND(cs.computed_retention::NUMERIC, 3) AS retention,
    cs.computed_mastery_color AS mastery_color,
    ROUND(cs.bkt_p_know::NUMERIC, 3) AS p_know,
    COALESCE(cs.fsrs_state_val, 'new') AS fsrs_state,
    cs.fsrs_due_at AS due_at,
    COALESCE(cs.fsrs_stability, 1)::NUMERIC AS stability,
    COALESCE(cs.fsrs_difficulty, 5)::NUMERIC AS difficulty,
    cs.card_is_new AS is_new,
    COUNT(*) OVER() AS total_count
  FROM cards_with_scores cs
  ORDER BY
    cs.computed_need_score DESC,
    cs.computed_retention ASC,
    cs.card_is_new ASC
  LIMIT p_limit;
END;
$$;

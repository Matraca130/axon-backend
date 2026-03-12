-- ============================================================
-- Migration: Study Queue RPC v3 Fixes
-- Date: 2026-03-12
-- Purpose: Fix 3 bugs in get_study_queue RPC
--
-- FIX 1: Retention formula — exp(-t/S) → POWER(1+t/(9*S), -1)
--         Matches fsrs-v4.ts calculateRetrievability() exactly.
--
-- FIX 2: NeedScore weights — hardcoded → read from algorithm_config
--         Falls back to global defaults (institution_id IS NULL).
--
-- FIX 3: Color scale — raw p_know → display_mastery (p_know * R)
--         Matches bkt-v4.ts calculateDisplayMastery().
--
-- BONUS: active_cards now filters status = 'published'
-- ============================================================

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
  v_overdue_w   NUMERIC;
  v_mastery_w   NUMERIC;
  v_fragility_w NUMERIC;
  v_novelty_w   NUMERIC;
  v_grace_days  NUMERIC;
BEGIN
  SELECT
    COALESCE(cfg.overdue_weight,   0.40),
    COALESCE(cfg.mastery_weight,   0.30),
    COALESCE(cfg.fragility_weight, 0.20),
    COALESCE(cfg.novelty_weight,   0.10),
    COALESCE(cfg.grace_days,       1.0)
  INTO v_overdue_w, v_mastery_w, v_fragility_w, v_novelty_w, v_grace_days
  FROM algorithm_config cfg
  WHERE cfg.institution_id IN (
    SELECT m.institution_id FROM memberships m
    WHERE m.user_id = p_student_id AND m.is_active = true
  )
  ORDER BY cfg.institution_id IS NULL ASC
  LIMIT 1;

  IF v_overdue_w IS NULL THEN
    v_overdue_w   := 0.40;
    v_mastery_w   := 0.30;
    v_fragility_w := 0.20;
    v_novelty_w   := 0.10;
    v_grace_days  := 1.0;
  END IF;

  RETURN QUERY
  WITH
  student_institutions AS (
    SELECT m.institution_id
    FROM memberships m
    WHERE m.user_id = p_student_id AND m.is_active = true
  ),
  student_courses AS (
    SELECT c.id
    FROM courses c
    WHERE c.institution_id IN (SELECT institution_id FROM student_institutions)
      AND c.is_active = true
  ),
  allowed_summaries AS (
    SELECT s.id
    FROM summaries s
    JOIN topics t ON t.id = s.topic_id AND t.deleted_at IS NULL
    JOIN sections sec ON sec.id = t.section_id AND sec.deleted_at IS NULL
    JOIN semesters sem ON sem.id = sec.semester_id AND sem.deleted_at IS NULL
    WHERE s.deleted_at IS NULL
      AND (
        (p_course_id IS NOT NULL AND sem.course_id = p_course_id)
        OR
        (p_course_id IS NULL AND sem.course_id IN (SELECT id FROM student_courses))
      )
  ),
  active_cards AS (
    SELECT f.id, f.summary_id, f.keyword_id, f.subtopic_id,
           f.front, f.back, f.front_image_url, f.back_image_url
    FROM flashcards f
    WHERE f.is_active = true AND f.deleted_at IS NULL
      AND f.status = 'published'
      AND f.summary_id IN (SELECT id FROM allowed_summaries)
  ),
  cards_with_fsrs AS (
    SELECT ac.*,
      fs.stability AS fsrs_stability,
      fs.difficulty AS fsrs_difficulty,
      fs.due_at AS fsrs_due_at,
      fs.last_review_at AS fsrs_last_review_at,
      fs.reps AS fsrs_reps,
      fs.lapses AS fsrs_lapses,
      fs.state AS fsrs_state_val,
      (fs.flashcard_id IS NULL) AS card_is_new,
      CASE
        WHEN fs.last_review_at IS NULL THEN 0
        ELSE GREATEST(0, EXTRACT(EPOCH FROM (v_now - fs.last_review_at)) / 86400.0)
      END AS elapsed_days
    FROM active_cards ac
    LEFT JOIN fsrs_states fs ON fs.flashcard_id = ac.id AND fs.student_id = p_student_id
    WHERE p_include_future OR fs.flashcard_id IS NULL OR fs.due_at <= v_now
  ),
  cards_with_scores AS (
    SELECT c.*,
      COALESCE(bkt.p_know, 0) AS bkt_p_know,
      (
        v_overdue_w * CASE
          WHEN c.fsrs_due_at IS NULL THEN 1.0
          WHEN v_now > c.fsrs_due_at THEN
            1.0 - EXP(-EXTRACT(EPOCH FROM (v_now - c.fsrs_due_at)) / 86400.0 / v_grace_days)
          ELSE 0.0
        END
        + v_mastery_w * (1.0 - COALESCE(bkt.p_know, 0))
        + v_fragility_w * LEAST(1.0,
            COALESCE(c.fsrs_lapses, 0)::NUMERIC
            / GREATEST(1, COALESCE(c.fsrs_reps, 0) + COALESCE(c.fsrs_lapses, 0) + 1)::NUMERIC)
        + v_novelty_w * CASE WHEN COALESCE(c.fsrs_state_val, 'new') = 'new' THEN 1.0 ELSE 0.0 END
      ) AS computed_need_score,
      CASE
        WHEN c.fsrs_last_review_at IS NULL OR COALESCE(c.fsrs_stability, 0) <= 0 THEN 0.0
        ELSE GREATEST(0, LEAST(1.0,
          POWER(1.0 + c.elapsed_days / (9.0 * COALESCE(c.fsrs_stability, 1)), -1)
        ))
      END AS computed_retention,
      CASE
        WHEN COALESCE(bkt.p_know, 0) <= 0 THEN 'gray'
        ELSE (
          SELECT CASE
            WHEN dm >= 0.80 THEN 'green'
            WHEN dm >= 0.50 THEN 'yellow'
            ELSE 'red'
          END
          FROM (SELECT COALESCE(bkt.p_know, 0) *
            CASE
              WHEN c.fsrs_last_review_at IS NULL OR COALESCE(c.fsrs_stability, 0) <= 0 THEN 1.0
              ELSE GREATEST(0, LEAST(1.0,
                POWER(1.0 + c.elapsed_days / (9.0 * COALESCE(c.fsrs_stability, 1)), -1)
              ))
            END AS dm) sub
        )
      END AS computed_mastery_color
    FROM cards_with_fsrs c
    LEFT JOIN bkt_states bkt ON bkt.subtopic_id = c.subtopic_id AND bkt.student_id = p_student_id
  )
  SELECT
    cs.id AS flashcard_id, cs.summary_id, cs.keyword_id, cs.subtopic_id,
    cs.front, cs.back, cs.front_image_url, cs.back_image_url,
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
  ORDER BY cs.computed_need_score DESC, cs.computed_retention ASC, cs.card_is_new ASC
  LIMIT p_limit;
END;
$$;

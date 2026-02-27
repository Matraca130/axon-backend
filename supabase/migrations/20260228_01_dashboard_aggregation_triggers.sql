-- ============================================================
-- Migration: Dashboard Aggregation Triggers
-- Date: 2026-02-28
-- Purpose: Auto-populate daily_activities and student_stats
--          from reviews and study_sessions events.
--
-- Problem: FlashcardReviewer, QuizTaker, SummaryView all write
--          to reviews and study_sessions correctly, but NOBODY
--          writes to daily_activities or student_stats.
--          Result: dashboard always shows empty.
--
-- Solution: Two Postgres triggers that fire AFTER INSERT/UPDATE
--           and aggregate data into the dashboard tables.
--           Zero frontend changes. Zero backend route changes.
--           Invisible to quiz/flashcard/summary teams.
--
-- Tables affected (READ):
--   reviews          — grade records (immutable)
--   study_sessions   — session log with completed_at
--
-- Tables affected (WRITE):
--   daily_activities — daily aggregates per student
--   student_stats    — lifetime aggregates per student
--
-- "Correct" thresholds (matches BKT engine):
--   quiz:      grade >= 1  (binary: 0=wrong, 1+=right)
--   flashcard: grade >= 3  (FSRS: 1=Again, 2=Hard, 3=Good, 4=Easy)
--
-- Safety:
--   - EXCEPTION WHEN OTHERS → RAISE WARNING (never breaks main op)
--   - Session duration capped at 7200s (2 hours)
--   - Idempotent: DROP IF EXISTS before CREATE
--   - Backfill at the end for historical data
-- ============================================================
-- NOTE: No explicit BEGIN/COMMIT needed.
-- Supabase migration runner auto-wraps each file in a transaction.
-- ============================================================

-- ═══════════════════════════════════════════════════════════════
-- 1. TRIGGER FUNCTION: on_review_inserted
--    Fires: AFTER INSERT ON reviews
--    Action: Increment daily_activities + student_stats
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.on_review_inserted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_student_id  uuid;
  v_today       date;
  v_is_correct  boolean;
BEGIN
  -- Step 1: Get student_id from study_sessions
  -- reviews does NOT have student_id directly.
  -- Must JOIN with study_sessions via session_id.
  SELECT ss.student_id
    INTO v_student_id
    FROM study_sessions ss
   WHERE ss.id = NEW.session_id;

  -- If session not found (orphan review), skip silently
  IF v_student_id IS NULL THEN
    RAISE WARNING '[on_review_inserted] session_id=% not found in study_sessions, skipping', NEW.session_id;
    RETURN NEW;
  END IF;

  -- Step 2: Determine "correct" by instrument_type
  -- quiz:      grade >= 1 (0=wrong, 1=right)
  -- flashcard: grade >= 3 (FSRS: 1=Again, 2=Hard, 3=Good, 4=Easy)
  IF NEW.instrument_type = 'quiz' THEN
    v_is_correct := (NEW.grade >= 1);
  ELSE
    v_is_correct := (NEW.grade >= 3);
  END IF;

  v_today := (NOW() AT TIME ZONE 'UTC')::date;

  -- Step 3: UPSERT daily_activities
  INSERT INTO daily_activities (student_id, activity_date, reviews_count, correct_count, time_spent_seconds, sessions_count, updated_at)
  VALUES (
    v_student_id,
    v_today,
    1,
    CASE WHEN v_is_correct THEN 1 ELSE 0 END,
    0,
    0,
    NOW()
  )
  ON CONFLICT (student_id, activity_date)
  DO UPDATE SET
    reviews_count = daily_activities.reviews_count + 1,
    correct_count = daily_activities.correct_count + CASE WHEN v_is_correct THEN 1 ELSE 0 END,
    updated_at    = NOW();

  -- Step 4: UPSERT student_stats
  INSERT INTO student_stats (student_id, total_reviews, total_sessions, total_time_seconds, current_streak, longest_streak, last_study_date, updated_at)
  VALUES (
    v_student_id,
    1,
    0,
    0,
    0,
    0,
    NULL,
    NOW()
  )
  ON CONFLICT (student_id)
  DO UPDATE SET
    total_reviews = student_stats.total_reviews + 1,
    updated_at    = NOW();

  RETURN NEW;

EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '[on_review_inserted] error: % — SQLSTATE: %', SQLERRM, SQLSTATE;
  RETURN NEW;
END;
$$;

-- Attach trigger
DROP TRIGGER IF EXISTS trg_review_inserted ON reviews;

CREATE TRIGGER trg_review_inserted
  AFTER INSERT ON reviews
  FOR EACH ROW
  EXECUTE FUNCTION public.on_review_inserted();


-- ═══════════════════════════════════════════════════════════════
-- 2. TRIGGER FUNCTION: on_study_session_completed
--    Fires: AFTER UPDATE ON study_sessions
--    Condition: completed_at transitions from NULL to non-NULL
--    Action: Increment daily_activities + student_stats + streak
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.on_study_session_completed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today         date;
  v_duration_secs numeric;
  v_prev_date     date;
  v_new_streak    integer;
BEGIN
  -- Guard: only fire when completed_at goes NULL → non-NULL
  IF OLD.completed_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.completed_at IS NULL THEN
    RETURN NEW;
  END IF;

  v_today := (NOW() AT TIME ZONE 'UTC')::date;

  -- Calculate duration (capped at 2h = 7200s)
  v_duration_secs := LEAST(
    EXTRACT(EPOCH FROM (NEW.completed_at - NEW.created_at)),
    7200
  );
  IF v_duration_secs < 0 THEN
    v_duration_secs := 0;
  END IF;

  -- UPSERT daily_activities
  INSERT INTO daily_activities (student_id, activity_date, reviews_count, correct_count, time_spent_seconds, sessions_count, updated_at)
  VALUES (
    NEW.student_id,
    v_today,
    0,
    0,
    v_duration_secs,
    1,
    NOW()
  )
  ON CONFLICT (student_id, activity_date)
  DO UPDATE SET
    time_spent_seconds = daily_activities.time_spent_seconds + v_duration_secs,
    sessions_count     = daily_activities.sessions_count + 1,
    updated_at         = NOW();

  -- Calculate streak
  SELECT last_study_date
    INTO v_prev_date
    FROM student_stats
   WHERE student_id = NEW.student_id;

  IF v_prev_date IS NULL THEN
    v_new_streak := 1;
  ELSIF v_prev_date = v_today THEN
    SELECT current_streak
      INTO v_new_streak
      FROM student_stats
     WHERE student_id = NEW.student_id;
    v_new_streak := GREATEST(COALESCE(v_new_streak, 1), 1);
  ELSIF v_prev_date = v_today - INTERVAL '1 day' THEN
    SELECT current_streak + 1
      INTO v_new_streak
      FROM student_stats
     WHERE student_id = NEW.student_id;
    v_new_streak := COALESCE(v_new_streak, 1);
  ELSE
    v_new_streak := 1;
  END IF;

  -- UPSERT student_stats
  INSERT INTO student_stats (student_id, total_reviews, total_sessions, total_time_seconds, current_streak, longest_streak, last_study_date, updated_at)
  VALUES (
    NEW.student_id,
    0,
    1,
    v_duration_secs,
    v_new_streak,
    v_new_streak,
    v_today,
    NOW()
  )
  ON CONFLICT (student_id)
  DO UPDATE SET
    total_sessions     = student_stats.total_sessions + 1,
    total_time_seconds = student_stats.total_time_seconds + v_duration_secs,
    current_streak     = v_new_streak,
    longest_streak     = GREATEST(student_stats.longest_streak, v_new_streak),
    last_study_date    = v_today,
    updated_at         = NOW();

  RETURN NEW;

EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '[on_study_session_completed] error: % — SQLSTATE: %', SQLERRM, SQLSTATE;
  RETURN NEW;
END;
$$;

-- Attach trigger
DROP TRIGGER IF EXISTS trg_study_session_completed ON study_sessions;

CREATE TRIGGER trg_study_session_completed
  AFTER UPDATE ON study_sessions
  FOR EACH ROW
  WHEN (OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL)
  EXECUTE FUNCTION public.on_study_session_completed();


-- ═══════════════════════════════════════════════════════════════
-- 3. BACKFILL: Populate from historical data
--    Runs once. Triggers handle all future data.
-- ═══════════════════════════════════════════════════════════════

-- 3a. Backfill daily_activities from reviews
INSERT INTO daily_activities (student_id, activity_date, reviews_count, correct_count, time_spent_seconds, sessions_count, updated_at)
SELECT
  ss.student_id,
  (r.created_at AT TIME ZONE 'UTC')::date AS activity_date,
  COUNT(*)::integer AS reviews_count,
  COUNT(*) FILTER (
    WHERE (r.instrument_type = 'quiz'      AND r.grade >= 1)
       OR (r.instrument_type != 'quiz'     AND r.grade >= 3)
  )::integer AS correct_count,
  0 AS time_spent_seconds,
  0 AS sessions_count,
  NOW()
FROM reviews r
JOIN study_sessions ss ON ss.id = r.session_id
GROUP BY ss.student_id, (r.created_at AT TIME ZONE 'UTC')::date
ON CONFLICT (student_id, activity_date)
DO UPDATE SET
  reviews_count = EXCLUDED.reviews_count,
  correct_count = EXCLUDED.correct_count,
  updated_at    = NOW();

-- 3b. Backfill daily_activities from completed sessions
WITH session_agg AS (
  SELECT
    student_id,
    (completed_at AT TIME ZONE 'UTC')::date AS activity_date,
    COUNT(*)::integer AS sessions_count,
    SUM(LEAST(
      GREATEST(EXTRACT(EPOCH FROM (completed_at - created_at)), 0),
      7200
    )) AS time_spent_seconds
  FROM study_sessions
  WHERE completed_at IS NOT NULL
  GROUP BY student_id, (completed_at AT TIME ZONE 'UTC')::date
)
INSERT INTO daily_activities (student_id, activity_date, reviews_count, correct_count, time_spent_seconds, sessions_count, updated_at)
SELECT
  sa.student_id,
  sa.activity_date,
  0,
  0,
  sa.time_spent_seconds,
  sa.sessions_count,
  NOW()
FROM session_agg sa
ON CONFLICT (student_id, activity_date)
DO UPDATE SET
  time_spent_seconds = daily_activities.time_spent_seconds + EXCLUDED.time_spent_seconds,
  sessions_count     = daily_activities.sessions_count + EXCLUDED.sessions_count,
  updated_at         = NOW();

-- 3c. Backfill student_stats (lifetime totals)
WITH review_totals AS (
  SELECT
    ss.student_id,
    COUNT(*)::integer AS total_reviews
  FROM reviews r
  JOIN study_sessions ss ON ss.id = r.session_id
  GROUP BY ss.student_id
),
session_totals AS (
  SELECT
    student_id,
    COUNT(*)::integer AS total_sessions,
    SUM(LEAST(
      GREATEST(EXTRACT(EPOCH FROM (completed_at - created_at)), 0),
      7200
    )) AS total_time_seconds,
    MAX((completed_at AT TIME ZONE 'UTC')::date) AS last_study_date
  FROM study_sessions
  WHERE completed_at IS NOT NULL
  GROUP BY student_id
),
active_days AS (
  SELECT student_id, activity_date
  FROM daily_activities
  WHERE reviews_count > 0 OR sessions_count > 0
),
ranked AS (
  SELECT
    student_id,
    activity_date,
    activity_date - (ROW_NUMBER() OVER (
      PARTITION BY student_id ORDER BY activity_date
    ))::integer AS grp
  FROM active_days
),
streak_groups AS (
  SELECT
    student_id,
    grp,
    COUNT(*)::integer AS streak_length,
    MAX(activity_date) AS streak_end
  FROM ranked
  GROUP BY student_id, grp
),
current_streaks AS (
  SELECT DISTINCT ON (sg.student_id)
    sg.student_id,
    sg.streak_length AS current_streak
  FROM streak_groups sg
  JOIN session_totals st ON st.student_id = sg.student_id
  WHERE sg.streak_end = st.last_study_date
  ORDER BY sg.student_id, sg.streak_length DESC
)
INSERT INTO student_stats (student_id, total_reviews, total_sessions, total_time_seconds, current_streak, longest_streak, last_study_date, updated_at)
SELECT
  COALESCE(rt.student_id, st.student_id) AS student_id,
  COALESCE(rt.total_reviews, 0),
  COALESCE(st.total_sessions, 0),
  COALESCE(st.total_time_seconds, 0),
  COALESCE(cs.current_streak, 0),
  COALESCE(cs.current_streak, 0),
  st.last_study_date,
  NOW()
FROM review_totals rt
FULL OUTER JOIN session_totals st ON rt.student_id = st.student_id
LEFT JOIN current_streaks cs ON cs.student_id = COALESCE(rt.student_id, st.student_id)
ON CONFLICT (student_id)
DO UPDATE SET
  total_reviews      = EXCLUDED.total_reviews,
  total_sessions     = EXCLUDED.total_sessions,
  total_time_seconds = EXCLUDED.total_time_seconds,
  current_streak     = EXCLUDED.current_streak,
  longest_streak     = GREATEST(student_stats.longest_streak, EXCLUDED.current_streak),
  last_study_date    = EXCLUDED.last_study_date,
  updated_at         = NOW();

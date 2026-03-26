-- Migration: Atomic increment RPCs for gamification race-condition fixes
--
-- Fixes two read-then-write race conditions:
--   1. _incrementStudentStat in xp-hooks.ts (total_reviews / total_sessions)
--   2. streak freeze decrement in streak-engine.ts (streak_freezes_owned)
--
-- Both were using SELECT-then-UPDATE, allowing concurrent calls to read the
-- same value and lose an increment. These RPCs use a single UPDATE with SQL
-- arithmetic, which is atomic within a single statement.

-- ─── 1. Atomic increment for student_stats counters ───────────────────
-- Called by xp-hooks.ts _incrementStudentStat()
-- Upserts the row if it doesn't exist (pre-onboarding students).

CREATE OR REPLACE FUNCTION increment_student_stat(
  p_student_id UUID,
  p_field TEXT,
  p_amount INT DEFAULT 1
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Validate field name to prevent SQL injection
  IF p_field NOT IN ('total_reviews', 'total_sessions') THEN
    RAISE EXCEPTION 'Invalid field: %. Allowed: total_reviews, total_sessions', p_field;
  END IF;

  -- Atomic upsert with increment: INSERT ... ON CONFLICT UPDATE using arithmetic
  INSERT INTO student_stats (student_id, current_streak, longest_streak, total_reviews, total_sessions, total_time_seconds, last_study_date, updated_at)
  VALUES (
    p_student_id, 0, 0,
    CASE WHEN p_field = 'total_reviews' THEN p_amount ELSE 0 END,
    CASE WHEN p_field = 'total_sessions' THEN p_amount ELSE 0 END,
    0, NULL, NOW()
  )
  ON CONFLICT (student_id) DO UPDATE SET
    total_reviews   = CASE WHEN p_field = 'total_reviews'  THEN student_stats.total_reviews  + p_amount ELSE student_stats.total_reviews  END,
    total_sessions  = CASE WHEN p_field = 'total_sessions' THEN student_stats.total_sessions + p_amount ELSE student_stats.total_sessions END,
    updated_at      = NOW();
END;
$$;

-- ─── 2. Atomic decrement for streak_freezes_owned ─────────────────────
-- Called by streak-engine.ts when consuming streak freezes.
-- Uses GREATEST(0, ...) to prevent negative values.

CREATE OR REPLACE FUNCTION decrement_streak_freezes(
  p_student_id UUID,
  p_institution_id UUID,
  p_amount INT DEFAULT 1
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE student_xp
  SET streak_freezes_owned = GREATEST(0, COALESCE(streak_freezes_owned, 0) - p_amount)
  WHERE student_id = p_student_id
    AND institution_id = p_institution_id;
END;
$$;

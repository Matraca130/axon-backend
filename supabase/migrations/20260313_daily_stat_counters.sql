-- Daily stat counters for efficient challenge evaluation
-- Eliminates O(n) COUNT queries for reviews_today/sessions_today
-- Also adds challenges_completed for Challenge Hunter badges
--
-- IMPORTANT: The student_stats row MUST already exist for increment_daily_stat()
-- and reset_correct_streak() to work. These RPCs use UPDATE (not UPSERT), so if
-- the row is missing, the UPDATE matches zero rows and the counter change is
-- silently lost. The row is created at enrollment time (see student enrollment
-- flow). If you see missing counters, check that the enrollment INSERT ran.

ALTER TABLE student_stats
  ADD COLUMN IF NOT EXISTS reviews_today INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sessions_today INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS correct_streak INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS challenges_completed INTEGER NOT NULL DEFAULT 0;

-- Atomic increment RPC -- whitelisted field names to prevent SQL injection
CREATE OR REPLACE FUNCTION increment_daily_stat(
  p_student_id UUID,
  p_field TEXT,
  p_amount INTEGER DEFAULT 1
) RETURNS void AS $$
BEGIN
  IF p_field = 'reviews_today' THEN
    UPDATE student_stats
      SET reviews_today = COALESCE(reviews_today, 0) + p_amount,
          total_reviews = COALESCE(total_reviews, 0) + p_amount
      WHERE student_id = p_student_id;
  ELSIF p_field = 'sessions_today' THEN
    UPDATE student_stats
      SET sessions_today = COALESCE(sessions_today, 0) + p_amount,
          total_sessions = COALESCE(total_sessions, 0) + p_amount
      WHERE student_id = p_student_id;
  ELSIF p_field = 'correct_streak' THEN
    UPDATE student_stats
      SET correct_streak = COALESCE(correct_streak, 0) + p_amount
      WHERE student_id = p_student_id;
  ELSIF p_field = 'challenges_completed' THEN
    UPDATE student_stats
      SET challenges_completed = COALESCE(challenges_completed, 0) + p_amount
      WHERE student_id = p_student_id;
  ELSE
    RAISE EXCEPTION 'Invalid field: %', p_field;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Reset correct_streak (called on incorrect answer)
CREATE OR REPLACE FUNCTION reset_correct_streak(
  p_student_id UUID
) RETURNS void AS $$
BEGIN
  UPDATE student_stats SET correct_streak = 0 WHERE student_id = p_student_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

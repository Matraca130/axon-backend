-- Migration: Atomic BKT state attempt counter increment
--
-- Fixes race condition in batch-review.ts where concurrent requests
-- read bkt_states.total_attempts/correct_attempts then write incremented
-- values, losing updates under concurrency.
--
-- This RPC atomically increments the counters using SQL arithmetic
-- (single UPDATE statement = atomic within one transaction).
-- Returns the new total_attempts and correct_attempts values.

CREATE OR REPLACE FUNCTION increment_bkt_attempts(
  p_student_id UUID,
  p_subtopic_id UUID,
  p_total_delta INT DEFAULT 1,
  p_correct_delta INT DEFAULT 0
)
RETURNS TABLE(new_total_attempts INT, new_correct_attempts INT)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  UPDATE bkt_states
  SET
    total_attempts   = COALESCE(total_attempts, 0) + p_total_delta,
    correct_attempts = COALESCE(correct_attempts, 0) + p_correct_delta
  WHERE student_id = p_student_id
    AND subtopic_id = p_subtopic_id
  RETURNING total_attempts, correct_attempts;
END;
$$;

-- BH-ERR-011: Add time_limit_seconds column for per-question timer
-- Q-UX2: Frontend already supports this field; backend was stripping it (BUG-020)
ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS time_limit_seconds INTEGER;
COMMENT ON COLUMN quizzes.time_limit_seconds IS 'Per-question time limit in seconds (null/0 = no limit)';

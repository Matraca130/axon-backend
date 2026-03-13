-- Student challenges table for Sprint 2 gamification
-- Tracks assigned challenges, progress, and completion/claim status.

CREATE TABLE IF NOT EXISTS student_challenges (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  challenge_type TEXT NOT NULL DEFAULT 'daily',
  challenge_slug TEXT NOT NULL,
  title          TEXT NOT NULL,
  description    TEXT,
  category       TEXT NOT NULL,
  criteria_field TEXT NOT NULL,
  criteria_op    TEXT NOT NULL DEFAULT '>=',
  criteria_value NUMERIC NOT NULL,
  current_value  NUMERIC NOT NULL DEFAULT 0,
  progress_pct   INTEGER NOT NULL DEFAULT 0,
  xp_reward      INTEGER NOT NULL,
  difficulty     TEXT NOT NULL DEFAULT 'easy',
  expires_at     TIMESTAMPTZ NOT NULL,
  completed_at   TIMESTAMPTZ,
  claimed_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_student_challenges_active
  ON student_challenges (student_id, institution_id, expires_at)
  WHERE claimed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_student_challenges_history
  ON student_challenges (student_id, institution_id, completed_at DESC)
  WHERE completed_at IS NOT NULL;

ALTER TABLE student_challenges ENABLE ROW LEVEL SECURITY;

CREATE POLICY student_challenges_select ON student_challenges
  FOR SELECT USING (auth.uid() = student_id);

CREATE POLICY student_challenges_insert ON student_challenges
  FOR INSERT WITH CHECK (auth.uid() = student_id);

CREATE POLICY student_challenges_update ON student_challenges
  FOR UPDATE USING (auth.uid() = student_id);

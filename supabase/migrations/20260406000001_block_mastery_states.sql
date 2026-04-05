-- Migration: block_mastery_states — Independent per-block mastery tracking
--
-- Stores BKT v4 mastery state per (student, block) pair, independent from
-- the keyword-based bkt_states system. Updated when a student completes
-- a block-level quiz via POST /block-review.

-- ── Table ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.block_mastery_states (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id       UUID NOT NULL REFERENCES auth.users(id),
  block_id         UUID NOT NULL REFERENCES public.summary_blocks(id) ON DELETE CASCADE,
  p_know           NUMERIC(6,4) NOT NULL DEFAULT 0,
  max_p_know       NUMERIC(6,4) NOT NULL DEFAULT 0,
  total_attempts   INT NOT NULL DEFAULT 0,
  correct_attempts INT NOT NULL DEFAULT 0,
  last_attempt_at  TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, block_id)
);

-- ── Index ────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_block_mastery_lookup
  ON block_mastery_states(student_id, block_id);

-- ── RLS (same pattern as bkt_states) ─────────────────────────────────

ALTER TABLE block_mastery_states ENABLE ROW LEVEL SECURITY;

CREATE POLICY "block_mastery_own_select" ON block_mastery_states
  FOR SELECT USING (student_id = auth.uid());

CREATE POLICY "block_mastery_own_insert" ON block_mastery_states
  FOR INSERT WITH CHECK (student_id = auth.uid());

CREATE POLICY "block_mastery_own_update" ON block_mastery_states
  FOR UPDATE USING (student_id = auth.uid());

CREATE POLICY "block_mastery_own_delete" ON block_mastery_states
  FOR DELETE USING (student_id = auth.uid());

CREATE POLICY "block_mastery_service_role_all" ON block_mastery_states
  FOR ALL USING (auth.role() = 'service_role');

-- ── Atomic increment RPC (mirrors increment_bkt_attempts) ────────────

CREATE OR REPLACE FUNCTION increment_block_mastery_attempts(
  p_student_id UUID,
  p_block_id UUID,
  p_total_delta INT DEFAULT 1,
  p_correct_delta INT DEFAULT 0
)
RETURNS TABLE(new_total_attempts INT, new_correct_attempts INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  UPDATE block_mastery_states
  SET
    total_attempts   = COALESCE(total_attempts, 0) + p_total_delta,
    correct_attempts = COALESCE(correct_attempts, 0) + p_correct_delta,
    updated_at       = now()
  WHERE student_id = p_student_id
    AND block_id = p_block_id
  RETURNING total_attempts, correct_attempts;
END;
$$;

-- Grant execute to authenticated users (RPC called from Edge Functions)
GRANT EXECUTE ON FUNCTION increment_block_mastery_attempts TO authenticated;

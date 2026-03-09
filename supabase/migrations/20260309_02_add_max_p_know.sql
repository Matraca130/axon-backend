-- ============================================================
-- Migration: add_max_p_know_to_bkt_states
-- Axon v4.5 — Fase 2
-- Date: 2026-03-09
--
-- PURPOSE: Track historical peak mastery for BKT recovery
--   When max_p_know > 0.50 AND current p_know < max_p_know,
--   the student is in "recovery mode" and learns 3x faster.
--   This models the cognitive science finding that relearning
--   previously known material is faster than learning fresh.
--
-- SAFETY: ALTER TABLE ADD COLUMN with DEFAULT NULL is
--   non-blocking in PostgreSQL 11+. No exclusive locks.
--   Existing queries are unaffected (they don't SELECT max_p_know).
--
-- ROLLBACK:
--   ALTER TABLE bkt_states DROP COLUMN IF EXISTS max_p_know;
--   DROP INDEX IF EXISTS idx_bkt_states_recovery;
-- ============================================================

-- Step 1: Add the column (non-blocking, no lock)
ALTER TABLE bkt_states
  ADD COLUMN IF NOT EXISTS max_p_know NUMERIC DEFAULT NULL;

-- Step 2: Backfill existing rows
-- The historical max is AT LEAST the current value.
-- NULL means "no history" → treated as 0 by the engine.
-- This UPDATE is a one-time scan, safe to run in production.
UPDATE bkt_states
  SET max_p_know = p_know
  WHERE max_p_know IS NULL
    AND p_know IS NOT NULL
    AND p_know > 0;

-- Step 3: Partial index for recovery queries
-- Only indexes rows where recovery could activate:
--   max_p_know > 0.50 (the MIN_MASTERY_FOR_RECOVERY threshold)
-- This keeps the index small (only students who reached 50%+)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bkt_states_recovery
  ON bkt_states (student_id, subtopic_id)
  WHERE max_p_know > 0.50;

-- Step 4: Comment for documentation
COMMENT ON COLUMN bkt_states.max_p_know IS
  'Historical peak mastery (p_know). Used by BKT recovery: '
  'when max_p_know > 0.50 AND p_know < max_p_know, recovery_factor=3.0x. '
  'NULL = no history (treated as 0). Added in Axon v4.5 Fase 2.';

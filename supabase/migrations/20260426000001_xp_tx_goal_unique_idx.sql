-- ============================================================
-- Migration: xp_transactions partial unique index for goal dedup
-- Date: 2026-04-26
-- Issue: #640 — POST /gamification/goals/complete TOCTOU race
--
-- Problem:
--   The route did SELECT COUNT (read) → awardXP() (write) without
--   atomicity. Two concurrent requests with the same
--   (student_id, institution_id, source_type='goal', source_id=goal_YYYY-MM-DD)
--   could both observe count=0 and both insert an xp_transactions row,
--   double-crediting the goal.
--
-- Fix:
--   Defense-in-depth at the DB level — a partial unique index that
--   blocks duplicate inserts for source_type='goal' specifically.
--   The application catches the resulting 23505 violation (via a
--   post-await probe) and surfaces it as 409.
--
-- Scope:
--   Limited to source_type='goal'. Other source_types (flashcard,
--   video, plan_task, etc.) legitimately reuse the same source_id
--   across many xp_transactions rows (e.g. reviewing the same card
--   multiple times) and must NOT be constrained.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS uq_xp_tx_goal_dedup
  ON xp_transactions (student_id, institution_id, source_id)
  WHERE source_type = 'goal';

COMMENT ON INDEX uq_xp_tx_goal_dedup IS
  'Partial unique index enforcing one goal-completion XP row per '
  '(student, institution, goal_type+date). Blocks TOCTOU double-credit '
  'in POST /gamification/goals/complete (issue #640).';

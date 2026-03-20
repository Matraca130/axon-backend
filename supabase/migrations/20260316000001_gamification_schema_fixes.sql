-- ============================================================
-- GAMIFICATION SCHEMA FIXES — Deep Audit v2
-- Date: 2026-03-16
--
-- B-002: xp_transactions.source_id must be TEXT not UUID
--        Code passes descriptive strings like 'checkin_2026-03-13'
--        and 'review_due_2026-03-13' for deduplication.
--
-- B-003: badge_definitions needs 'criteria TEXT' column
--        check-badges endpoint reads criteria for evaluation
--        but seed data only populates trigger_config JSONB.
--        This migration adds criteria and populates it from
--        trigger_config for student_stats-based badges.
-- ============================================================

-- ═══════════════════════════════════════════════════════════════
-- B-002: Change source_id from UUID to TEXT
-- ═══════════════════════════════════════════════════════════════
-- The code uses descriptive source_id strings for deduplication:
--   - 'checkin_2026-03-13' (daily streak check-in)
--   - 'review_due_2026-03-13' (goal completion)
-- These are NOT valid UUIDs and would cause INSERT failures.

ALTER TABLE xp_transactions
  ALTER COLUMN source_id TYPE TEXT
  USING source_id::TEXT;

COMMENT ON COLUMN xp_transactions.source_id IS
  'Identifier for triggering entity. TEXT (not UUID) to support '
  'descriptive dedup keys like checkin_YYYY-MM-DD and goal_type_YYYY-MM-DD.';

-- ═══════════════════════════════════════════════════════════════
-- B-003: Add criteria column to badge_definitions
-- ═══════════════════════════════════════════════════════════════
-- check-badges endpoint uses evaluateSimpleCondition(criteria, row)
-- which parses strings like 'current_streak >= 3'.
-- Populate criteria from trigger_config.condition for student_stats badges.

ALTER TABLE badge_definitions
  ADD COLUMN IF NOT EXISTS criteria TEXT;

-- Populate criteria for student_stats-based badges
-- These have simple conditions that evaluateSimpleCondition can parse
UPDATE badge_definitions
SET criteria = trigger_config->>'condition'
WHERE trigger_config->>'table' = 'student_stats'
  AND trigger_config->>'condition' IS NOT NULL;

-- For student_xp-based badges (total_xp, current_level)
-- These would also work with evaluateSimpleCondition
UPDATE badge_definitions
SET criteria = trigger_config->>'condition'
WHERE trigger_config->>'table' = 'student_xp'
  AND trigger_config->>'condition' IS NOT NULL;

COMMENT ON COLUMN badge_definitions.criteria IS
  'Simple condition string for evaluateSimpleCondition() evaluation. '
  'Format: field_name operator value (e.g. current_streak >= 3). '
  'NULL for badges requiring custom evaluation (COUNT-based, etc).';

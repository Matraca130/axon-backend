-- ============================================================
-- Migration: Fix xp_collector badge trigger_config
-- Date: 2026-03-13
-- Purpose: Redirect 4 xp_collector badges from `flashcards` table
--          (professor content, no student_id) to `fsrs_states`
--          (student SRS state, has student_id + flashcard_id).
--
-- Problem:
--   xp_collector badges had trigger_config pointing to `flashcards`
--   with filter "deleted_at IS NULL". But flashcards is a content
--   table owned by professors — it has NO student_id column.
--   The COUNT evaluator in check-badges correctly skipped these
--   (table not in whitelist), so they were permanently unearnable.
--
-- Solution:
--   Redirect to `fsrs_states` which has:
--     - student_id (FK to auth.users)
--     - flashcard_id (FK to flashcards)
--     - UNIQUE(student_id, flashcard_id)
--   Each row = 1 flashcard the student has incorporated into their
--   spaced repetition system. COUNT(*) gives "cards in SRS".
--
-- Semantic alignment (SDT/Octalysis):
--   "XP Collector" = student who has STUDIED many different flashcards
--   This maps to Competence (SDT) and Accomplishment (Octalysis)
--   better than counting professor-created content.
--
-- Affected badges (4):
--   xp_collector_bronze:   COUNT(*) >= 10
--   xp_collector_silver:   COUNT(*) >= 100
--   xp_collector_platinum: COUNT(*) >= 500
--   xp_collector_gold:     COUNT(*) >= 1000
-- ============================================================

-- Rebuild trigger_config: change table, keep condition, drop filter
-- (fsrs_states has no deleted_at column)
UPDATE badge_definitions
SET trigger_config = jsonb_build_object(
  'table', 'fsrs_states',
  'condition', trigger_config->>'condition'
)
WHERE slug IN (
  'xp_collector_bronze',
  'xp_collector_silver',
  'xp_collector_gold',
  'xp_collector_platinum'
)
AND trigger_config->>'table' = 'flashcards';

-- Verification: all 4 should now point to fsrs_states
DO $$
DECLARE
  v_count INTEGER;
  v_details TEXT;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM badge_definitions
  WHERE slug IN (
    'xp_collector_bronze',
    'xp_collector_silver',
    'xp_collector_gold',
    'xp_collector_platinum'
  )
  AND trigger_config->>'table' = 'fsrs_states';

  IF v_count != 4 THEN
    -- Show what we found for debugging
    SELECT string_agg(slug || ' -> ' || (trigger_config->>'table'), ', ')
    INTO v_details
    FROM badge_definitions
    WHERE slug IN (
      'xp_collector_bronze',
      'xp_collector_silver',
      'xp_collector_gold',
      'xp_collector_platinum'
    );
    RAISE EXCEPTION 'Expected 4 xp_collector badges pointing to fsrs_states, found %. Details: %', v_count, v_details;
  END IF;

  RAISE NOTICE '[OK] 4 xp_collector badges redirected: flashcards -> fsrs_states';
END $$;

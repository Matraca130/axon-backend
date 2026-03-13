-- ============================================================
-- Migration: Fix Recolector Badge trigger_config
-- Date: 2026-03-13
-- Purpose: Redirect 4 Recolector badges from `flashcards` table
--          (professor content, no student_id) to `fsrs_states`
--          (student SRS state, has student_id + flashcard_id).
--
-- Problem:
--   Recolector badges had trigger_config pointing to `flashcards`
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
--   "Recolector" = student who has STUDIED many different flashcards
--   This maps to Competence (SDT) and Accomplishment (Octalysis)
--   better than counting professor-created content.
--
-- Affected badges (4):
--   recolector-novato:  COUNT(*) >= 10
--   recolector:         COUNT(*) >= 50
--   gran-recolector:    COUNT(*) >= 100
--   recolector-supremo: COUNT(*) >= 250
-- ============================================================

-- Rebuild trigger_config: change table, keep condition, drop filter
-- (fsrs_states has no deleted_at column)
UPDATE badge_definitions
SET trigger_config = jsonb_build_object(
  'table', 'fsrs_states',
  'condition', trigger_config->>'condition'
)
WHERE slug IN (
  'recolector-novato',
  'recolector',
  'gran-recolector',
  'recolector-supremo'
)
AND trigger_config->>'table' = 'flashcards';

-- Verification: all 4 should now point to fsrs_states
DO $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM badge_definitions
  WHERE slug IN (
    'recolector-novato',
    'recolector',
    'gran-recolector',
    'recolector-supremo'
  )
  AND trigger_config->>'table' = 'fsrs_states';

  IF v_count != 4 THEN
    RAISE EXCEPTION 'Expected 4 Recolector badges pointing to fsrs_states, found %', v_count;
  END IF;

  RAISE NOTICE '[OK] 4 Recolector badges redirected: flashcards -> fsrs_states';
END $$;

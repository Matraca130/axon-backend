-- ============================================================================
-- Migration: Alter weekly_reports for Phase 1 weekly study reports
-- Date: 2026-04-04
-- Purpose: Add ai_recommendations column, convert ai_strengths/ai_weaknesses
--          from JSONB to TEXT[], remove unused columns for new report format.
-- Note: Base table created by 20260320000001_weekly_reports.sql
-- ============================================================================

-- Add the new ai_recommendations column
ALTER TABLE weekly_reports
  ADD COLUMN IF NOT EXISTS ai_recommendations TEXT[] DEFAULT '{}';

-- Convert ai_strengths from JSONB to TEXT[] (if still JSONB)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'weekly_reports'
      AND column_name = 'ai_strengths'
      AND data_type = 'jsonb'
  ) THEN
    -- Create temp columns, migrate data, swap
    ALTER TABLE weekly_reports ADD COLUMN ai_strengths_new TEXT[] DEFAULT '{}';
    UPDATE weekly_reports SET ai_strengths_new = ARRAY(
      SELECT jsonb_array_elements_text(COALESCE(ai_strengths, '[]'::jsonb))
    ) WHERE ai_strengths IS NOT NULL
      AND jsonb_typeof(COALESCE(ai_strengths, '[]'::jsonb)) = 'array';
    ALTER TABLE weekly_reports DROP COLUMN ai_strengths;
    ALTER TABLE weekly_reports RENAME COLUMN ai_strengths_new TO ai_strengths;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'weekly_reports'
      AND column_name = 'ai_weaknesses'
      AND data_type = 'jsonb'
  ) THEN
    ALTER TABLE weekly_reports ADD COLUMN ai_weaknesses_new TEXT[] DEFAULT '{}';
    UPDATE weekly_reports SET ai_weaknesses_new = ARRAY(
      SELECT jsonb_array_elements_text(COALESCE(ai_weaknesses, '[]'::jsonb))
    ) WHERE ai_weaknesses IS NOT NULL
      AND jsonb_typeof(COALESCE(ai_weaknesses, '[]'::jsonb)) = 'array';
    ALTER TABLE weekly_reports DROP COLUMN ai_weaknesses;
    ALTER TABLE weekly_reports RENAME COLUMN ai_weaknesses_new TO ai_weaknesses;
  END IF;
END $$;

-- Relax NOT NULL constraints on columns the new code doesn't populate
ALTER TABLE weekly_reports ALTER COLUMN accuracy_percent DROP NOT NULL;
ALTER TABLE weekly_reports ALTER COLUMN accuracy_percent SET DEFAULT 0;

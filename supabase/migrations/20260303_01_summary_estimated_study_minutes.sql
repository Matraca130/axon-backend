-- ============================================================================
-- Migration: 20260303_01_summary_estimated_study_minutes.sql
-- Description: Add estimated_study_minutes column to summaries table and
--              create ai_reading_config table for admin-controlled AI
--              reading time estimation instructions.
-- ============================================================================

-- 1. New column on summaries for estimated reading/study time
-- Nullable integer: NULL means "not set" (frontend uses fallback).
-- Can be set by the professor manually or via AI suggestion.
ALTER TABLE summaries
  ADD COLUMN IF NOT EXISTS estimated_study_minutes integer DEFAULT NULL;

COMMENT ON COLUMN summaries.estimated_study_minutes IS
  'Estimated reading/study time in minutes. Set by professor or suggested by AI. NULL = use fallback.';

-- 2. AI reading config table — one row per institution
-- The institution admin/owner configures the AI instructions and constants
-- that the AI endpoint uses when analyzing summary content_markdown.
CREATE TABLE IF NOT EXISTS ai_reading_config (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id        uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  instructions          text NOT NULL DEFAULT '',
  base_wpm              integer NOT NULL DEFAULT 200,
  image_extra_seconds   integer NOT NULL DEFAULT 30,
  formula_extra_seconds integer NOT NULL DEFAULT 45,
  is_active             boolean NOT NULL DEFAULT true,
  updated_at            timestamptz DEFAULT now(),
  updated_by            uuid REFERENCES auth.users(id),
  UNIQUE(institution_id)
);

COMMENT ON TABLE ai_reading_config IS
  'AI configuration for reading time estimation. One row per institution. Admin/owner configures instructions and constants.';

-- 3. RLS for ai_reading_config
ALTER TABLE ai_reading_config ENABLE ROW LEVEL SECURITY;

-- Any authenticated user can read config (needed by the AI endpoint)
CREATE POLICY "Authenticated users can read ai_reading_config"
  ON ai_reading_config FOR SELECT TO authenticated
  USING (true);

-- Insert/update allowed for authenticated users (backend validates admin role)
CREATE POLICY "Authenticated users can insert ai_reading_config"
  ON ai_reading_config FOR INSERT TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update ai_reading_config"
  ON ai_reading_config FOR UPDATE TO authenticated
  USING (true) WITH CHECK (true);

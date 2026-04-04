-- ============================================================================
-- Migration: weekly_reports table
-- Date: 2026-04-04
-- Purpose: Store AI-generated weekly study reports per student per institution.
-- ============================================================================

CREATE TABLE IF NOT EXISTS weekly_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  week_start DATE NOT NULL,
  week_end DATE NOT NULL,

  -- Raw stats
  total_sessions INT DEFAULT 0,
  total_reviews INT DEFAULT 0,
  correct_reviews INT DEFAULT 0,
  total_time_seconds INT DEFAULT 0,
  days_active INT DEFAULT 0,
  streak_at_report INT DEFAULT 0,
  xp_earned INT DEFAULT 0,

  -- AI analysis
  ai_summary TEXT,
  ai_strengths TEXT[] DEFAULT '{}',
  ai_weaknesses TEXT[] DEFAULT '{}',
  ai_recommendations TEXT[] DEFAULT '{}',
  ai_model TEXT,

  created_at TIMESTAMPTZ DEFAULT now(),

  -- One report per student per institution per week
  CONSTRAINT weekly_reports_unique UNIQUE (student_id, institution_id, week_start)
);

CREATE INDEX idx_weekly_reports_student
  ON weekly_reports(student_id, institution_id, week_start DESC);

ALTER TABLE weekly_reports ENABLE ROW LEVEL SECURITY;

-- Students can read their own reports
CREATE POLICY "weekly_reports_own_select" ON weekly_reports
  FOR SELECT USING (student_id = auth.uid());

-- Service role can insert/update (AI generation runs as admin)
CREATE POLICY "weekly_reports_service_all" ON weekly_reports
  FOR ALL USING (auth.role() = 'service_role');

-- Weekly Reports: persistent weekly classification snapshots
-- Used by GET/POST /ai/weekly-report endpoint

CREATE TABLE IF NOT EXISTS weekly_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES auth.users(id),
  institution_id UUID NOT NULL REFERENCES institutions(id),
  week_start DATE NOT NULL,
  week_end DATE NOT NULL,

  -- Raw data snapshot
  total_sessions INTEGER NOT NULL DEFAULT 0,
  total_reviews INTEGER NOT NULL DEFAULT 0,
  correct_reviews INTEGER NOT NULL DEFAULT 0,
  accuracy_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  total_time_seconds INTEGER NOT NULL DEFAULT 0,
  days_active INTEGER NOT NULL DEFAULT 0,
  streak_at_report INTEGER NOT NULL DEFAULT 0,
  xp_earned INTEGER NOT NULL DEFAULT 0,

  -- Topic classification
  weak_topics JSONB NOT NULL DEFAULT '[]',
  strong_topics JSONB NOT NULL DEFAULT '[]',
  lapsing_cards JSONB NOT NULL DEFAULT '[]',

  -- AI analysis
  ai_summary TEXT,
  ai_strengths JSONB DEFAULT '[]',
  ai_weaknesses JSONB DEFAULT '[]',
  ai_mastery_trend TEXT,
  ai_recommended_focus JSONB DEFAULT '[]',
  ai_model TEXT,
  ai_tokens_used INTEGER DEFAULT 0,
  ai_latency_ms INTEGER DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(student_id, institution_id, week_start)
);

CREATE INDEX idx_weekly_reports_student ON weekly_reports(student_id, created_at DESC);
CREATE INDEX idx_weekly_reports_inst ON weekly_reports(institution_id, week_start DESC);

ALTER TABLE weekly_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "weekly_reports_select_own" ON weekly_reports
  FOR SELECT USING (student_id = auth.uid());

CREATE POLICY "weekly_reports_insert_own" ON weekly_reports
  FOR INSERT WITH CHECK (student_id = auth.uid());

CREATE POLICY "weekly_reports_service_role_all" ON weekly_reports
  FOR ALL USING (auth.role() = 'service_role');

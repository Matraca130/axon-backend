-- Migration: ai_schedule_logs table for tracking Claude schedule agent usage
-- Supports analytics, cost tracking, and debugging for the schedule agent endpoint.

CREATE TABLE IF NOT EXISTS ai_schedule_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  student_id UUID NOT NULL,
  institution_id UUID,
  action VARCHAR(20) NOT NULL,
  model VARCHAR(20) NOT NULL DEFAULT 'sonnet',
  status VARCHAR(10) NOT NULL DEFAULT 'success',
  tokens_used INTEGER DEFAULT 0,
  latency_ms INTEGER DEFAULT 0,
  error_message TEXT,
  fallback_reason VARCHAR(30),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_schedule_logs_inst
  ON ai_schedule_logs (institution_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_schedule_logs_student
  ON ai_schedule_logs (student_id, created_at DESC);

ALTER TABLE ai_schedule_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own AI schedule logs"
  ON ai_schedule_logs FOR SELECT
  USING (student_id = auth.uid());

CREATE POLICY "Service role full access on ai_schedule_logs"
  ON ai_schedule_logs FOR ALL
  USING (auth.role() = 'service_role');

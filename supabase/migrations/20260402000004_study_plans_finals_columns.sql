-- ============================================================================
-- Migration: Extend study_plans for finals badge support
-- Date: 2026-04-02
-- Purpose: Add is_finals_plan flag and exam_event_id FK to study_plans.
-- ============================================================================

ALTER TABLE study_plans
  ADD COLUMN IF NOT EXISTS is_finals_plan BOOLEAN DEFAULT false;

ALTER TABLE study_plans
  ADD COLUMN IF NOT EXISTS exam_event_id UUID REFERENCES exam_events(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_study_plans_finals
  ON study_plans(student_id)
  WHERE is_finals_plan = true;

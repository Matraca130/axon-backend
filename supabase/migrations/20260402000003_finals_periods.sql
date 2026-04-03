-- ============================================================================
-- Migration: finals_periods table
-- Date: 2026-04-02
-- Purpose: Track institution/course finals periods for effort-based badges.
-- ============================================================================

CREATE TABLE finals_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  course_id UUID REFERENCES courses(id) ON DELETE CASCADE,  -- NULL = institution-wide
  finals_period_start DATE NOT NULL,
  finals_period_end DATE NOT NULL,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now(),

  CONSTRAINT finals_period_dates_valid CHECK (finals_period_end >= finals_period_start)
);

CREATE INDEX idx_finals_periods_lookup
  ON finals_periods(institution_id, course_id);
CREATE INDEX idx_finals_periods_dates
  ON finals_periods(finals_period_start, finals_period_end);

ALTER TABLE finals_periods ENABLE ROW LEVEL SECURITY;

-- Students can read finals periods for their institution
CREATE POLICY "read_own_institution_finals" ON finals_periods
  FOR SELECT USING (
    institution_id IN (
      SELECT institution_id FROM memberships
      WHERE user_id = auth.uid() AND is_active = true
    )
  );

-- Professors/admins/owners can manage finals periods
CREATE POLICY "manage_finals_periods" ON finals_periods
  FOR ALL USING (
    institution_id IN (
      SELECT institution_id FROM memberships
      WHERE user_id = auth.uid()
        AND role IN ('professor', 'admin', 'owner')
        AND is_active = true
    )
  );

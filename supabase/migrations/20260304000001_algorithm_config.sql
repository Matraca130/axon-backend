-- ============================================================
-- Migration: Algorithm Config Table
-- Date: 2026-03-04
-- Purpose: Store algorithm parameters in DB instead of hardcoding.
--          Allows admin to tune NeedScore & BKT weights via API.
--
-- One row per institution (institution-level config).
-- Falls back to default row (institution_id IS NULL) for global defaults.
-- ============================================================

CREATE TABLE IF NOT EXISTS algorithm_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID REFERENCES institutions(id) ON DELETE CASCADE,

  -- NeedScore v4.2 weights (must sum to 1.0)
  overdue_weight   NUMERIC NOT NULL DEFAULT 0.40 CHECK (overdue_weight BETWEEN 0 AND 1),
  mastery_weight   NUMERIC NOT NULL DEFAULT 0.30 CHECK (mastery_weight BETWEEN 0 AND 1),
  fragility_weight NUMERIC NOT NULL DEFAULT 0.20 CHECK (fragility_weight BETWEEN 0 AND 1),
  novelty_weight   NUMERIC NOT NULL DEFAULT 0.10 CHECK (novelty_weight BETWEEN 0 AND 1),
  grace_days       NUMERIC NOT NULL DEFAULT 1.0  CHECK (grace_days > 0),

  -- BKT priors (defaults for new students)
  bkt_p_know       NUMERIC NOT NULL DEFAULT 0.10 CHECK (bkt_p_know BETWEEN 0 AND 1),
  bkt_p_transit    NUMERIC NOT NULL DEFAULT 0.30 CHECK (bkt_p_transit BETWEEN 0 AND 1),
  bkt_p_slip       NUMERIC NOT NULL DEFAULT 0.10 CHECK (bkt_p_slip BETWEEN 0 AND 1),
  bkt_p_guess      NUMERIC NOT NULL DEFAULT 0.25 CHECK (bkt_p_guess BETWEEN 0 AND 1),

  -- Version tag for tracking changes
  version          TEXT NOT NULL DEFAULT 'v4.2',

  -- Audit
  updated_by       UUID REFERENCES profiles(id),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Weight sum constraint (tolerance 0.02 for floating point)
  CONSTRAINT weights_sum_check CHECK (
    ABS(overdue_weight + mastery_weight + fragility_weight + novelty_weight - 1.0) < 0.02
  ),

  -- BKT validity constraint
  CONSTRAINT bkt_validity_check CHECK (
    bkt_p_slip + bkt_p_guess < 1.0
  ),

  -- One config per institution (NULL = global default)
  CONSTRAINT unique_institution_config UNIQUE (institution_id)
);

-- Seed global defaults
INSERT INTO algorithm_config (institution_id)
VALUES (NULL)
ON CONFLICT (institution_id) DO NOTHING;

-- Index for lookup
CREATE INDEX IF NOT EXISTS idx_algorithm_config_institution
  ON algorithm_config(institution_id);

-- RLS
ALTER TABLE algorithm_config ENABLE ROW LEVEL SECURITY;

-- Anyone authenticated can read (needed for study-queue to read weights)
CREATE POLICY "algorithm_config_select" ON algorithm_config
  FOR SELECT
  TO authenticated
  USING (true);

-- Only admin/owner can insert/update their institution's config
CREATE POLICY "algorithm_config_admin_write" ON algorithm_config
  FOR ALL
  USING (
    institution_id IN (
      SELECT institution_id FROM memberships
      WHERE user_id = auth.uid() AND role IN ('admin', 'owner')
    )
  )
  WITH CHECK (
    institution_id IN (
      SELECT institution_id FROM memberships
      WHERE user_id = auth.uid() AND role IN ('admin', 'owner')
    )
  );

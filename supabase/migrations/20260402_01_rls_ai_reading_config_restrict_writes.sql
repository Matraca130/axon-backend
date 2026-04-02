-- ============================================================================
-- Migration: Restrict ai_reading_config RLS — writes to service_role only
-- Date: 2026-04-02
-- Finding: MEDIUM — ai_reading_config INSERT/UPDATE open to all authenticated
-- Fix: Drop permissive authenticated write policies, keep SELECT for reading
--
-- Pattern: Same as platform_plans fix (20260326_01)
-- The table stores admin-configured AI instructions per institution.
-- Reads needed by AI endpoints (authenticated SELECT stays).
-- Writes should only come from service_role (backend admin routes).
-- ============================================================================

-- Drop the overly permissive write policies for authenticated users
DROP POLICY IF EXISTS "Authenticated users can insert ai_reading_config" ON ai_reading_config;
DROP POLICY IF EXISTS "Authenticated users can update ai_reading_config" ON ai_reading_config;

-- SELECT for authenticated stays (needed by AI endpoint) — already exists:
--   "Authenticated users can read ai_reading_config" FOR SELECT USING (true)

-- Add service_role full access policy (not present in original migration)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'ai_reading_config'
      AND policyname = 'ai_reading_config_service_role_all'
  ) THEN
    CREATE POLICY "ai_reading_config_service_role_all" ON ai_reading_config
      FOR ALL USING (auth.role() = 'service_role');
    RAISE NOTICE '[OK] ai_reading_config — service_role_all policy created';
  ELSE
    RAISE NOTICE '[SKIP] ai_reading_config — service_role_all policy already exists';
  END IF;
END; $$;

-- ── Verification ──────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_count INT;
BEGIN
  -- Check authenticated policies: should be exactly 1 (SELECT only)
  SELECT count(*) INTO v_count
  FROM pg_policies
  WHERE tablename = 'ai_reading_config'
    AND policyname LIKE '%uthenticated%';

  IF v_count = 1 THEN
    RAISE NOTICE '[OK] ai_reading_config — 1 authenticated policy remaining (SELECT only)';
  ELSE
    RAISE WARNING '[UNEXPECTED] ai_reading_config — expected 1 authenticated policy, found %', v_count;
  END IF;

  -- Confirm service_role policy exists
  SELECT count(*) INTO v_count
  FROM pg_policies
  WHERE tablename = 'ai_reading_config'
    AND policyname = 'ai_reading_config_service_role_all';

  IF v_count = 1 THEN
    RAISE NOTICE '[OK] ai_reading_config — service_role_all policy present';
  ELSE
    RAISE WARNING '[MISSING] ai_reading_config — service_role_all policy not found!';
  END IF;
END; $$;

-- ============================================================================
-- Migration: Restrict platform_plans RLS — writes to service_role only
-- Date: 2026-03-26
-- Finding: HIGH — platform_plans INSERT/UPDATE/DELETE open to all authenticated
-- Fix: Drop permissive authenticated write policies, keep SELECT for browsing
--
-- NOTE: The crud-factory (routes/plans/crud.ts) currently uses the user client
-- (db from authenticate()). After this migration, POST/PUT/DELETE on
-- /platform-plans via the crud route will require switching to
-- getAdminClient(). A follow-up code change is needed in crud-factory
-- or the plans route to use the admin client for platform_plans writes.
-- ============================================================================

-- Drop the overly permissive write policies for authenticated users
DROP POLICY IF EXISTS "platform_plans_authenticated_insert" ON platform_plans;
DROP POLICY IF EXISTS "platform_plans_authenticated_update" ON platform_plans;
DROP POLICY IF EXISTS "platform_plans_authenticated_delete" ON platform_plans;

-- SELECT for authenticated stays (students browse plans) — already exists:
--   "platform_plans_authenticated_select" FOR SELECT USING (auth.role() = 'authenticated')

-- service_role full access already exists:
--   "platform_plans_service_role_all" FOR ALL USING (auth.role() = 'service_role')

-- ── Verification ──────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_count INT;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_policies
  WHERE tablename = 'platform_plans'
    AND policyname LIKE '%authenticated%';

  IF v_count = 1 THEN
    RAISE NOTICE '[OK] platform_plans — 1 authenticated policy remaining (SELECT only)';
  ELSE
    RAISE WARNING '[UNEXPECTED] platform_plans — expected 1 authenticated policy, found %', v_count;
  END IF;

  -- Confirm service_role policy exists
  SELECT count(*) INTO v_count
  FROM pg_policies
  WHERE tablename = 'platform_plans'
    AND policyname = 'platform_plans_service_role_all';

  IF v_count = 1 THEN
    RAISE NOTICE '[OK] platform_plans — service_role_all policy present';
  ELSE
    RAISE WARNING '[MISSING] platform_plans — service_role_all policy not found!';
  END IF;
END; $$;

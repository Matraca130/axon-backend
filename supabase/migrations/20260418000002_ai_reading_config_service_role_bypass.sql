-- ============================================================================
-- Migration: Add service_role FOR ALL bypass on ai_reading_config
-- Date: 2026-04-18
-- Follow-up to 20260418000001 (Phase 1) per security-scanner post-apply
-- review finding N1 (MEDIUM).
--
-- Phase 1 replaced permissive INSERT+UPDATE policies with owner/admin-only
-- ones referencing memberships. If a future cron job / Edge Function
-- attempts to upsert ai_reading_config via user JWT (non-admin role) or
-- even via service_role with no explicit bypass policy, writes fail.
--
-- Adding FOR ALL TO service_role guarantees internal writes keep working
-- without exposing anything to the data API (service_role bypasses are
-- the Supabase-canonical pattern).
-- ============================================================================

BEGIN;

CREATE POLICY ai_reading_config_service_role_all ON public.ai_reading_config
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Verification
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public'
      AND tablename='ai_reading_config'
      AND policyname='ai_reading_config_service_role_all'
  ) THEN
    RAISE EXCEPTION 'service_role bypass policy not created';
  END IF;
  RAISE NOTICE '[OK] ai_reading_config_service_role_all policy created';
END $$;

COMMIT;

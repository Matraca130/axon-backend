-- ============================================================================
-- Migration: Enable RLS on public._temp_image_store (service_role only)
-- Date: 2026-04-08
--
-- Lint finding: public._temp_image_store is exposed in the public schema but
-- has RLS disabled. The table is a backend-only staging area for chunked
-- image uploads (columns: id, chunk_index, data, total_chunks, created_at)
-- and has no ownership column, so per-user policies are not meaningful.
--
-- Fix: enable RLS and add a single FOR ALL policy that only matches
-- service_role. Anon/authenticated requests via PostgREST will get an
-- empty result set / permission denied even if GRANTs ever leak in.
--
-- Hygiene: also REVOKE table privileges from anon and authenticated so the
-- table is invisible to PostgREST regardless of policy state.
-- ============================================================================

ALTER TABLE public._temp_image_store ENABLE ROW LEVEL SECURITY;

CREATE POLICY "_temp_image_store_service_role_all"
  ON public._temp_image_store
  FOR ALL
  TO public
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

REVOKE ALL ON TABLE public._temp_image_store FROM anon, authenticated;

-- ── Verification ─────────────────────────────────────────────
DO $$
DECLARE
  v_rls BOOLEAN;
  v_policy_count INT;
BEGIN
  SELECT relrowsecurity INTO v_rls
  FROM pg_class
  WHERE relname = '_temp_image_store'
    AND relnamespace = 'public'::regnamespace;

  SELECT count(*) INTO v_policy_count
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = '_temp_image_store';

  IF v_rls IS NULL THEN
    RAISE WARNING '[SKIP] _temp_image_store — table does not exist';
  ELSIF v_rls THEN
    RAISE NOTICE '[OK] _temp_image_store — RLS enabled, % policies', v_policy_count;
  ELSE
    RAISE WARNING '[FAIL] _temp_image_store — RLS NOT enabled!';
  END IF;
END; $$;

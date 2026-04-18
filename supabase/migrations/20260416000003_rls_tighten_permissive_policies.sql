-- ============================================================================
-- Migration: Tighten permissive "WITH CHECK (true)" RLS policies
-- Date: 2026-04-16
-- Advisor lint: rls_policy_always_true (WARN, 3 findings)
--
-- Problem:
--   Three RLS policies still grant unrestricted writes:
--     1. ai_reading_config — INSERT policy
--        "Authenticated users can insert ai_reading_config" (WITH CHECK true)
--     2. ai_reading_config — UPDATE policy
--        "Authenticated users can update ai_reading_config" (USING true, WITH CHECK true)
--     3. image_generation_log — INSERT policy `gen_log_insert`
--        (WITH CHECK true, role = public)
--
--   Migration 20260402000001_security_revoke_batch_2.sql attempted to tighten
--   #1 and #2 on 2026-04-02, but a live pg_policies query on 2026-04-16 still
--   shows the permissive versions in place. Either that migration never
--   executed in production, or a later DEFINE reverted it. Re-applying the
--   fix idempotently below.
--
--   `image_generation_log` #3 is brand-new: the existing policy lets any
--   anonymous PostgREST caller write arbitrary rows into the audit table.
--   Backend callers (flashcard-images.ts:135, infographic-images.ts:145/247)
--   all use `getAdminClient()` (service_role), which bypasses RLS; dropping
--   the public policy does not break them.
--
-- Fix:
--   Phase 1 (ai_reading_config): drop permissive INSERT/UPDATE policies and
--     re-create them gated on institution membership with role IN (owner,admin).
--     Keep the existing SELECT policy — the AI reading endpoint needs all
--     authenticated users to read configuration.
--   Phase 2 (image_generation_log): drop `gen_log_insert`. All legitimate
--     writes go through service_role (admin client) which bypasses RLS.
--
-- Rollback (not recommended):
--   -- Phase 1: recreate "Authenticated users can insert/update" with WITH CHECK (true)
--   -- Phase 2: CREATE POLICY gen_log_insert ON public.image_generation_log
--   --           FOR INSERT WITH CHECK (true);
-- ============================================================================


-- ═══════════════════════════════════════════════════════════════════
-- PHASE 1: ai_reading_config — restrict writes to institution owner/admin
-- ═══════════════════════════════════════════════════════════════════

-- Drop any permissive legacy policies (idempotent)
DROP POLICY IF EXISTS "Authenticated users can insert ai_reading_config"
  ON public.ai_reading_config;
DROP POLICY IF EXISTS "Authenticated users can update ai_reading_config"
  ON public.ai_reading_config;

-- Drop the owner/admin versions if a previous partial run left stubs,
-- so the CREATE below is unconditionally clean.
DROP POLICY IF EXISTS "Owner/admin can insert ai_reading_config"
  ON public.ai_reading_config;
DROP POLICY IF EXISTS "Owner/admin can update ai_reading_config"
  ON public.ai_reading_config;

-- New INSERT: only owner/admin of the target institution
CREATE POLICY "Owner/admin can insert ai_reading_config"
  ON public.ai_reading_config
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.memberships m
       WHERE m.user_id = auth.uid()
         AND m.institution_id = ai_reading_config.institution_id
         AND m.role IN ('owner', 'admin')
         AND m.is_active = TRUE
    )
  );

-- New UPDATE: only owner/admin of the target institution (both USING + WITH CHECK)
CREATE POLICY "Owner/admin can update ai_reading_config"
  ON public.ai_reading_config
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.memberships m
       WHERE m.user_id = auth.uid()
         AND m.institution_id = ai_reading_config.institution_id
         AND m.role IN ('owner', 'admin')
         AND m.is_active = TRUE
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.memberships m
       WHERE m.user_id = auth.uid()
         AND m.institution_id = ai_reading_config.institution_id
         AND m.role IN ('owner', 'admin')
         AND m.is_active = TRUE
    )
  );


-- ═══════════════════════════════════════════════════════════════════
-- PHASE 2: image_generation_log — drop permissive INSERT
-- ═══════════════════════════════════════════════════════════════════

-- Only service_role (admin client) writes to this audit table in production.
-- No legitimate user-token INSERT path exists.
DROP POLICY IF EXISTS gen_log_insert ON public.image_generation_log;


-- ═══════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ═══════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_count int;
BEGIN
  -- Expect 2 owner/admin policies on ai_reading_config
  SELECT count(*) INTO v_count
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename  = 'ai_reading_config'
     AND policyname LIKE 'Owner/admin%';
  IF v_count = 2 THEN
    RAISE NOTICE '[OK] ai_reading_config — 2 owner/admin write policies present';
  ELSE
    RAISE WARNING '[UNEXPECTED] ai_reading_config — expected 2 owner/admin policies, found %', v_count;
  END IF;

  -- Expect 0 permissive policies remain
  SELECT count(*) INTO v_count
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename  = 'ai_reading_config'
     AND policyname LIKE 'Authenticated users can %';
  IF v_count = 0 THEN
    RAISE NOTICE '[OK] ai_reading_config — permissive write policies removed';
  ELSE
    RAISE WARNING '[UNEXPECTED] ai_reading_config — % permissive policies still present', v_count;
  END IF;

  -- Expect gen_log_insert gone
  SELECT count(*) INTO v_count
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename  = 'image_generation_log'
     AND policyname = 'gen_log_insert';
  IF v_count = 0 THEN
    RAISE NOTICE '[OK] image_generation_log — gen_log_insert removed';
  ELSE
    RAISE WARNING '[UNEXPECTED] image_generation_log — gen_log_insert still present';
  END IF;
END; $$;

-- ============================================================================
-- Migration: Security REVOKE batch 2 — AXO-45
-- Date: 2026-04-02
-- Supersedes: AXO-40 (corrected scope per CTO review)
--
-- Phase 1: REVOKE anon on get_course_summary_ids
--   get_institution_summary_ids already service_role-only (20260311000003)
--
-- Phase 2: REVOKE authenticated on award_xp + buy_streak_freeze
--   award_xp: students could self-award XP via PostgREST RPC
--   buy_streak_freeze: already called via adminDb, authenticated grant unneeded
--   search_scoped: SAFE — uses auth.uid() internally, no spoofing
--   trash_scoped: SAFE — read-only listing, uses auth.uid() internally
--   resolve_summary_institution: SAFE — lookup only
--   search_keywords_by_institution: SAFE — scoped read
--
-- Phase 3: RLS ai_reading_config — restrict INSERT/UPDATE to owner/admin
-- ============================================================================


-- ═══════════════════════════════════════════════════════════════════
-- PHASE 1: REVOKE anon from get_course_summary_ids
-- ═══════════════════════════════════════════════════════════════════

-- get_course_summary_ids was granted to anon in 20260227000002.
-- An unauthenticated attacker could enumerate summary IDs via PostgREST.
-- Keep authenticated — Edge Functions call via db.rpc() (user JWT).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'get_course_summary_ids'
  ) THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION get_course_summary_ids(uuid) FROM anon';
    RAISE NOTICE '[OK] get_course_summary_ids — anon revoked';
  ELSE
    RAISE NOTICE '[SKIP] get_course_summary_ids — function does not exist';
  END IF;
END; $$;

-- get_institution_summary_ids: already revoked in 20260311000003 (service_role only).
-- Idempotent re-revoke for safety.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'get_institution_summary_ids'
  ) THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION get_institution_summary_ids(uuid) FROM anon';
    RAISE NOTICE '[OK] get_institution_summary_ids — anon revoked (idempotent)';
  ELSE
    RAISE NOTICE '[SKIP] get_institution_summary_ids — function does not exist';
  END IF;
END; $$;


-- ═══════════════════════════════════════════════════════════════════
-- PHASE 2: REVOKE authenticated from award_xp + buy_streak_freeze
-- ═══════════════════════════════════════════════════════════════════

-- award_xp: SECURITY FIX — students could call POST /rest/v1/rpc/award_xp
-- directly via PostgREST and self-award arbitrary XP.
-- Edge Function code (xp-engine.ts) switched to use getAdminClient() (service_role).
REVOKE EXECUTE ON FUNCTION award_xp(UUID, UUID, TEXT, INT, NUMERIC, TEXT, TEXT, TEXT)
  FROM authenticated;

-- buy_streak_freeze: already called via adminDb.rpc() in streak.ts.
-- The authenticated grant is unnecessary and allows direct PostgREST abuse.
REVOKE EXECUTE ON FUNCTION buy_streak_freeze(UUID, UUID, INT)
  FROM authenticated;


-- ═══════════════════════════════════════════════════════════════════
-- PHASE 3: RLS ai_reading_config — restrict writes to owner/admin
-- ═══════════════════════════════════════════════════════════════════

-- Current state: INSERT/UPDATE WITH CHECK (true) — any authenticated user can
-- write any row. This is too permissive; only institution owner/admin should
-- configure AI reading settings.

-- Drop overly permissive write policies
DROP POLICY IF EXISTS "Authenticated users can insert ai_reading_config" ON ai_reading_config;
DROP POLICY IF EXISTS "Authenticated users can update ai_reading_config" ON ai_reading_config;

-- Keep SELECT policy: "Authenticated users can read ai_reading_config" — needed
-- by AI endpoint for all authenticated users.

-- New INSERT: only owner/admin of the institution
CREATE POLICY "Owner/admin can insert ai_reading_config"
  ON ai_reading_config FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.user_id = auth.uid()
        AND m.institution_id = ai_reading_config.institution_id
        AND m.role IN ('owner', 'admin')
        AND m.is_active = TRUE
    )
  );

-- New UPDATE: only owner/admin of the institution
CREATE POLICY "Owner/admin can update ai_reading_config"
  ON ai_reading_config FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.user_id = auth.uid()
        AND m.institution_id = ai_reading_config.institution_id
        AND m.role IN ('owner', 'admin')
        AND m.is_active = TRUE
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.user_id = auth.uid()
        AND m.institution_id = ai_reading_config.institution_id
        AND m.role IN ('owner', 'admin')
        AND m.is_active = TRUE
    )
  );


-- ═══════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ═══════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_count INT;
BEGIN
  -- Verify ai_reading_config policies
  SELECT count(*) INTO v_count
  FROM pg_policies
  WHERE tablename = 'ai_reading_config'
    AND policyname LIKE 'Owner/admin%';

  IF v_count = 2 THEN
    RAISE NOTICE '[OK] ai_reading_config — 2 owner/admin write policies created';
  ELSE
    RAISE WARNING '[UNEXPECTED] ai_reading_config — expected 2 owner/admin policies, found %', v_count;
  END IF;

  -- Verify SELECT still exists
  SELECT count(*) INTO v_count
  FROM pg_policies
  WHERE tablename = 'ai_reading_config'
    AND policyname = 'Authenticated users can read ai_reading_config';

  IF v_count = 1 THEN
    RAISE NOTICE '[OK] ai_reading_config — SELECT policy still present';
  ELSE
    RAISE WARNING '[MISSING] ai_reading_config — SELECT policy not found!';
  END IF;
END; $$;

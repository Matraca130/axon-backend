-- ============================================================================
-- Migration: RLS helper function — auth.user_institution_ids()
-- Part of D3 RLS rollout (S11)
-- Date: 2026-03-19
--
-- Purpose: Returns an array of institution UUIDs where the calling user
-- has an active membership. Used by RLS policies to scope row access
-- without per-query RPCs.
--
-- SECURITY DEFINER: Runs as the function owner (bypasses RLS on
-- memberships) so the lookup always succeeds. search_path is locked
-- to prevent search_path injection attacks.
-- ============================================================================

CREATE OR REPLACE FUNCTION auth.user_institution_ids()
RETURNS UUID[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    array_agg(institution_id),
    ARRAY[]::UUID[]
  )
  FROM memberships
  WHERE user_id = auth.uid()
    AND is_active = true;
$$;

COMMENT ON FUNCTION auth.user_institution_ids IS
  'S11/D3: Returns institution UUIDs where the calling user has an active membership. Used by RLS policies. SECURITY DEFINER, search_path locked.';

-- Grant to authenticated role so RLS policies can call it
GRANT EXECUTE ON FUNCTION auth.user_institution_ids() TO authenticated;

-- Verification
DO $$
BEGIN
  RAISE NOTICE 'auth.user_institution_ids() created successfully';
END; $$;

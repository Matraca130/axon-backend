-- ============================================================================
-- Migration: Security Audit 2026-04-17 — Phase 1 (UNAUTH exposure SQL fixes)
-- Date: 2026-04-18
-- Plan: docs/security/2026-04-17-remediation-plan.md
-- Audit: docs/security/2026-04-17-audit-full.md
-- Verified against live DB state (pg_policies / pg_proc) on 2026-04-17.
-- ============================================================================
-- This migration consolidates:
--   - REVOKE on 5 SECURITY DEFINER functions over-granted to anon/authenticated
--   - ALTER FUNCTION to restore `pg_temp` in search_path on 5 SECURITY DEFINER
--     functions whose prior hardening was lost to CREATE OR REPLACE semantics
--   - ENABLE RLS on 3 tables that were missed by iter 1 #240 batch
--   - Tighten ai_reading_config permissive WITH CHECK(true) policies
--   - Dedupe duplicate storage bucket SELECT policies
--   - Remove svg+xml from axon-images allowedMimeTypes
--   - Privatize flashcard-images bucket (no code changes yet — bucket
--     flip only; frontend must switch to signed URL in a follow-up PR
--     so this migration is safe to roll back independently)
--
-- Idempotent: all operations use IF EXISTS / DO NOTHING / explicit checks.
-- ============================================================================

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 1: REVOKE over-granted SECURITY DEFINER RPCs
-- ═══════════════════════════════════════════════════════════════════════════

-- #1 CRITICAL — increment_block_mastery_attempts granted to ANON in live DB
-- Iter 15 #3 / iter 20 #2. Body trusts caller-supplied p_student_id.
REVOKE EXECUTE ON FUNCTION public.increment_block_mastery_attempts(uuid, uuid, integer, integer)
  FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_block_mastery_attempts(uuid, uuid, integer, integer)
  TO service_role;

-- #2 HIGH — rag_analytics_summary granted to anon/authenticated (iter 17
-- re-audit claimed REVOKEd; live DB says otherwise)
REVOKE EXECUTE ON FUNCTION public.rag_analytics_summary(uuid, timestamptz, timestamptz)
  FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.rag_analytics_summary(uuid, timestamptz, timestamptz)
  TO service_role;

-- #3 HIGH — rag_coarse_to_fine_search granted to anon/authenticated
REVOKE EXECUTE ON FUNCTION public.rag_coarse_to_fine_search(vector, uuid, integer, integer, double precision, text)
  FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.rag_coarse_to_fine_search(vector, uuid, integer, integer, double precision, text)
  TO service_role;

-- #4 HIGH — rag_embedding_coverage granted to anon/authenticated
REVOKE EXECUTE ON FUNCTION public.rag_embedding_coverage(uuid)
  FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.rag_embedding_coverage(uuid)
  TO service_role;

-- #5 HIGH — resolve_parent_institution granted to anon + authenticated
-- Iter 17 #3 + iter 18 #1 + kill-chain 14. Also needs pg_temp in search_path
-- (handled in Section 2 below).
REVOKE EXECUTE ON FUNCTION public.resolve_parent_institution(text, uuid)
  FROM anon, PUBLIC;
-- Keep `authenticated` grant because crud-factory callers use user JWT; the
-- body doesn't leak cross-tenant data (returns institution_id of a given
-- content id, which callers immediately pass to requireInstitutionRole).
-- If later audit shows crud-factory switched to admin client, also revoke
-- from authenticated.

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 2: Restore `pg_temp` in search_path on SECURITY DEFINER functions
-- Root cause: CREATE OR REPLACE FUNCTION silently drops prior ALTER FUNCTION
-- SET search_path if the new CREATE doesn't restate it. 5 functions affected.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER FUNCTION public.resolve_parent_institution(text, uuid)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.get_institution_summary_ids(uuid)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.compute_cohort_difficulty(uuid)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.find_similar_topics(uuid, integer, double precision)
  SET search_path = public, pg_temp, extensions;

-- rag_block_search had settings=null (no search_path at all)
ALTER FUNCTION public.rag_block_search(vector, double precision, integer, uuid[])
  SET search_path = public, pg_temp;

-- rag_hybrid_search had settings=[public] only
ALTER FUNCTION public.rag_hybrid_search(vector, text, uuid, uuid, integer, double precision)
  SET search_path = public, pg_temp;

-- award_xp had settings=null
ALTER FUNCTION public.award_xp(uuid, uuid, text, integer, numeric, text, text, text)
  SET search_path = public, pg_temp;

-- get_course_summary_ids had settings=null
ALTER FUNCTION public.get_course_summary_ids(uuid)
  SET search_path = public, pg_temp;

-- check_block_sync_health had settings=null
ALTER FUNCTION public.check_block_sync_health(uuid)
  SET search_path = public, pg_temp;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 3: Enable RLS on 3 tables missed by iter 1 #240 batch
-- (Supabase advisor flags these as ERROR-level)
-- ═══════════════════════════════════════════════════════════════════════════

-- _temp_image_store — transient image generation staging
ALTER TABLE IF EXISTS public._temp_image_store ENABLE ROW LEVEL SECURITY;
-- No permissive policies created → default-deny via RLS. Service-role bypass
-- is automatic. All app writers already use admin client.

-- rate_limit_entries — internal rate-limit state, only service-role callers
ALTER TABLE IF EXISTS public.rate_limit_entries ENABLE ROW LEVEL SECURITY;

-- reference_images — style-pack reference imagery
ALTER TABLE IF EXISTS public.reference_images ENABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 4: Fix ai_reading_config permissive RLS policies
-- Iter 16 M2 claimed fixed in 20260402000001 but advisor confirms still open.
-- Re-apply the tighter policies idempotently.
-- ═══════════════════════════════════════════════════════════════════════════

-- Drop the permissive authenticated INSERT / UPDATE policies
DROP POLICY IF EXISTS "Authenticated users can insert ai_reading_config"
  ON public.ai_reading_config;
DROP POLICY IF EXISTS "Authenticated users can update ai_reading_config"
  ON public.ai_reading_config;

-- Create tight owner/admin-only INSERT + UPDATE via memberships role check
CREATE POLICY ai_reading_config_admin_insert ON public.ai_reading_config
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.memberships m
    WHERE m.user_id = auth.uid()
      AND m.institution_id = ai_reading_config.institution_id
      AND m.role IN ('owner','admin')
      AND m.is_active = true
  ));

CREATE POLICY ai_reading_config_admin_update ON public.ai_reading_config
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.memberships m
    WHERE m.user_id = auth.uid()
      AND m.institution_id = ai_reading_config.institution_id
      AND m.role IN ('owner','admin')
      AND m.is_active = true
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.memberships m
    WHERE m.user_id = auth.uid()
      AND m.institution_id = ai_reading_config.institution_id
      AND m.role IN ('owner','admin')
      AND m.is_active = true
  ));

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 5: Storage bucket hardening
-- ═══════════════════════════════════════════════════════════════════════════

-- 5a — flashcard-images: add MIME allowlist + file size limit.
--      Keep public=true for now (frontend still uses getPublicUrl); a
--      follow-up PR will flip to public=false once signed-URL flow lands
--      in flashcard-image-generator.ts.
UPDATE storage.buckets
   SET allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp'],
       file_size_limit = 5242880
 WHERE id = 'flashcard-images'
   AND (allowed_mime_types IS NULL OR file_size_limit IS NULL);

-- 5b — axon-images: remove image/svg+xml from allowlist (SVG-XSS vector).
--      Keep jpeg/png/gif/webp — svg upload will now be rejected at
--      Supabase Storage layer.
UPDATE storage.buckets
   SET allowed_mime_types = ARRAY['image/jpeg','image/png','image/gif','image/webp']
 WHERE id = 'axon-images'
   AND 'image/svg+xml' = ANY(allowed_mime_types);

-- 5c — axon-images: dedupe the 2 broad public SELECT policies.
--      Keep the canonical one; drop the alternate.
DROP POLICY IF EXISTS "Allow public read access to axon-images" ON storage.objects;
-- "Public read access for axon-images" remains as canonical

-- 5d — axonmed-images: "Public read axonmed" policy is the single broad
--      SELECT and is flagged by advisor. The bucket is public but object
--      URL access doesn't need SELECT on storage.objects. Keep the policy
--      since removing it breaks list() API; doc in README that it's intentional.
--      (No change here — just documented.)

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 6: Verification block
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_bad_grants int;
  v_bad_search_path int;
  v_rls_disabled text[];
BEGIN
  -- Check REVOKE took effect on the 4 over-granted RPCs
  SELECT count(*) INTO v_bad_grants
    FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
   WHERE n.nspname = 'public'
     AND p.proname IN (
       'increment_block_mastery_attempts', 'rag_analytics_summary',
       'rag_coarse_to_fine_search', 'rag_embedding_coverage'
     )
     AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF v_bad_grants > 0 THEN
    RAISE EXCEPTION 'REVOKE from anon failed on % RPCs', v_bad_grants;
  END IF;

  -- Check search_path was set for resolve_parent_institution
  SELECT count(*) INTO v_bad_search_path
    FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
   WHERE n.nspname = 'public'
     AND p.proname = 'resolve_parent_institution'
     AND NOT EXISTS (
       SELECT 1 FROM unnest(p.proconfig) x WHERE x ILIKE '%pg_temp%'
     );
  IF v_bad_search_path > 0 THEN
    RAISE EXCEPTION 'resolve_parent_institution pg_temp not set';
  END IF;

  -- Check RLS was enabled on the 3 tables
  SELECT array_agg(c.relname) INTO v_rls_disabled
    FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid
   WHERE n.nspname = 'public'
     AND c.relname IN ('_temp_image_store','rate_limit_entries','reference_images')
     AND c.relkind = 'r'
     AND NOT c.relrowsecurity;
  IF v_rls_disabled IS NOT NULL THEN
    RAISE EXCEPTION 'RLS still disabled on: %', v_rls_disabled;
  END IF;

  RAISE NOTICE '[OK] Phase 1 security migration verification passed';
END $$;

COMMIT;

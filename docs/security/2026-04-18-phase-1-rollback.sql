-- ============================================================================
-- Phase 1 emergency rollback SQL
-- Run ONLY if Phase 1 + follow-ups caused a production outage.
--
-- This script restores the pre-Phase-1 live state. It is NOT idempotent
-- beyond the initial rollback run (a second run will fail because the
-- policies it CREATEs already exist).
--
-- Pre-conditions:
--   - You have confirmed the regression is caused by Phase 1 (not by
--     unrelated code or infra changes).
--   - Supabase live project is `xdnciktarvxyhkrokbng`.
--
-- Addresses quality-gate concern "Rollback readiness: Partial — no
-- pre-staged rollback SQL".
-- ============================================================================

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- UNDO SECTION 1: Re-grant REVOKEd RPCs
-- ═══════════════════════════════════════════════════════════════════════════

GRANT EXECUTE ON FUNCTION public.increment_block_mastery_attempts(uuid, uuid, integer, integer)
  TO anon;
GRANT EXECUTE ON FUNCTION public.rag_analytics_summary(uuid, timestamptz, timestamptz)
  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_coarse_to_fine_search(vector, uuid, integer, integer, double precision, text)
  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_embedding_coverage(uuid)
  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_parent_institution(text, uuid)
  TO anon;

-- ═══════════════════════════════════════════════════════════════════════════
-- UNDO SECTION 2: RESET search_path on ALTERed functions
-- ═══════════════════════════════════════════════════════════════════════════
-- We only restore pre-Phase-1 values. award_xp, rag_block_search,
-- get_course_summary_ids, check_block_sync_health had NO search_path (null).
-- resolve_parent_institution, get_institution_summary_ids, rag_hybrid_search
-- had [public] only. compute_cohort_difficulty had [public] only.
-- find_similar_topics had [public, extensions]. Restore each to prior state.

ALTER FUNCTION public.resolve_parent_institution(text, uuid) SET search_path = public;
ALTER FUNCTION public.get_institution_summary_ids(uuid) SET search_path = public;
ALTER FUNCTION public.compute_cohort_difficulty(uuid) SET search_path = public;
ALTER FUNCTION public.find_similar_topics(uuid, integer, double precision) SET search_path = public, extensions;
ALTER FUNCTION public.rag_hybrid_search(vector, text, uuid, uuid, integer, double precision) SET search_path = public;
ALTER FUNCTION public.rag_block_search(vector, double precision, integer, uuid[]) RESET search_path;
ALTER FUNCTION public.award_xp(uuid, uuid, text, integer, numeric, text, text, uuid) RESET search_path;
ALTER FUNCTION public.get_course_summary_ids(uuid) RESET search_path;
ALTER FUNCTION public.check_block_sync_health(uuid) RESET search_path;

-- ═══════════════════════════════════════════════════════════════════════════
-- UNDO SECTION 3: Disable RLS on 3 tables
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE IF EXISTS public._temp_image_store DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.rate_limit_entries DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.reference_images DISABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════════════════════════
-- UNDO SECTION 4: Restore permissive ai_reading_config policies + drop the tight ones
-- ═══════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS ai_reading_config_admin_insert ON public.ai_reading_config;
DROP POLICY IF EXISTS ai_reading_config_admin_update ON public.ai_reading_config;
DROP POLICY IF EXISTS ai_reading_config_service_role_all ON public.ai_reading_config;

CREATE POLICY "Authenticated users can insert ai_reading_config" ON public.ai_reading_config
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can update ai_reading_config" ON public.ai_reading_config
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════════════════
-- UNDO SECTION 5: Bucket MIME allowlist + storage.objects policies
-- ═══════════════════════════════════════════════════════════════════════════

-- Restore svg+xml on axon-images
UPDATE storage.buckets
   SET allowed_mime_types = ARRAY['image/jpeg','image/png','image/gif','image/webp','image/svg+xml']
 WHERE id = 'axon-images';

-- Remove MIME allowlist + size cap from flashcard-images (return to pre-Phase-1 null)
UPDATE storage.buckets
   SET allowed_mime_types = NULL,
       file_size_limit = NULL
 WHERE id = 'flashcard-images';

-- Recreate the 3 dropped policies (with their original quals)
CREATE POLICY "Allow public read access to axon-images" ON storage.objects
  FOR SELECT
  USING (bucket_id = 'axon-images'::text);

CREATE POLICY "Anon update axonmed" ON storage.objects
  FOR UPDATE
  USING (bucket_id = 'axonmed-images'::text);

-- "Anon upload axonmed" was already absent before Phase 1 per advisor output;
-- no restore needed. If your live state had it, uncomment:
-- CREATE POLICY "Anon upload axonmed" ON storage.objects
--   FOR INSERT
--   WITH CHECK (bucket_id = 'axonmed-images'::text);

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- Post-rollback verification: confirm reverted state
-- ═══════════════════════════════════════════════════════════════════════════

-- After running the rollback, validate:
-- 1. anon again has EXECUTE on the 5 RPCs:
--    SELECT proname, has_function_privilege('anon', oid, 'EXECUTE')
--    FROM pg_proc WHERE pronamespace = 'public'::regnamespace
--    AND proname IN ('increment_block_mastery_attempts','rag_analytics_summary',
--                    'rag_coarse_to_fine_search','rag_embedding_coverage',
--                    'resolve_parent_institution');
-- 2. Bucket axon-images has svg+xml:
--    SELECT allowed_mime_types FROM storage.buckets WHERE id='axon-images';
-- 3. The permissive ai_reading_config policies exist:
--    SELECT policyname FROM pg_policies WHERE tablename='ai_reading_config';

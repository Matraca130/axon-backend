-- ============================================================================
-- Phase 1 post-apply verification SQL
-- Run via: supabase db execute (or Supabase SQL editor)
--
-- Read-only. Safe to run any time post-Phase-1 to assert live state matches
-- what the migration claimed. Returns NOTICE per section; RAISE EXCEPTION on
-- any divergence.
--
-- Addresses quality-gate review concern #1 (only 1 of 9 ALTER FUNCTION
-- targets was asserted by the migration's own verification block).
-- ============================================================================

DO $$
DECLARE
  v_missing_pg_temp text[];
  v_wrong_grant text[];
  v_permissive_remaining int;
  v_axonimg_svg int;
  v_bucket_state record;
BEGIN
  -- 1. All 9 ALTER FUNCTION targets must have pg_temp in proconfig
  SELECT array_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')')
    INTO v_missing_pg_temp
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
   WHERE n.nspname = 'public'
     AND p.proname IN (
       'resolve_parent_institution', 'get_institution_summary_ids',
       'compute_cohort_difficulty', 'find_similar_topics',
       'rag_block_search', 'rag_hybrid_search', 'award_xp',
       'get_course_summary_ids', 'check_block_sync_health'
     )
     AND NOT EXISTS (
       SELECT 1 FROM unnest(p.proconfig) x WHERE x ILIKE '%pg_temp%'
     );
  IF v_missing_pg_temp IS NOT NULL THEN
    RAISE EXCEPTION 'pg_temp missing on: %', v_missing_pg_temp;
  END IF;
  RAISE NOTICE '[OK] All 9 ALTER FUNCTION targets have pg_temp in search_path';

  -- 2. REVOKE from anon on 5 RPCs must be in place
  SELECT array_agg(p.proname) INTO v_wrong_grant
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
   WHERE n.nspname = 'public'
     AND p.proname IN (
       'increment_block_mastery_attempts', 'rag_analytics_summary',
       'rag_coarse_to_fine_search', 'rag_embedding_coverage',
       'resolve_parent_institution'
     )
     AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF v_wrong_grant IS NOT NULL THEN
    RAISE EXCEPTION 'anon still has EXECUTE on: %', v_wrong_grant;
  END IF;
  RAISE NOTICE '[OK] 5 RPCs revoked from anon';

  -- 3. REVOKE from authenticated on 3 admin-only RAG RPCs
  SELECT array_agg(p.proname) INTO v_wrong_grant
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
   WHERE n.nspname = 'public'
     AND p.proname IN (
       'rag_analytics_summary', 'rag_coarse_to_fine_search',
       'rag_embedding_coverage'
     )
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_wrong_grant IS NOT NULL THEN
    RAISE EXCEPTION 'authenticated still has EXECUTE on admin-only RAG RPCs: %', v_wrong_grant;
  END IF;
  RAISE NOTICE '[OK] 3 admin-only RAG RPCs revoked from authenticated';

  -- 4. RLS enabled on 3 tables
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = 'public'
      AND c.relname IN ('_temp_image_store','rate_limit_entries','reference_images')
      AND c.relkind = 'r'
      AND NOT c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'RLS still disabled on one of: _temp_image_store / rate_limit_entries / reference_images';
  END IF;
  RAISE NOTICE '[OK] RLS enabled on 3 tables';

  -- 5. No permissive (qual='true' OR with_check='true') policies on ai_reading_config INSERT/UPDATE
  SELECT count(*) INTO v_permissive_remaining
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename = 'ai_reading_config'
     AND cmd IN ('INSERT','UPDATE')
     AND (qual = 'true' OR with_check = 'true');
  IF v_permissive_remaining > 0 THEN
    RAISE EXCEPTION 'Permissive WITH CHECK(true) still present on ai_reading_config INSERT/UPDATE';
  END IF;
  RAISE NOTICE '[OK] ai_reading_config permissive INSERT/UPDATE policies removed';

  -- 6. axon-images bucket MIME allowlist has no svg+xml
  SELECT count(*) INTO v_axonimg_svg
    FROM storage.buckets
   WHERE id = 'axon-images'
     AND 'image/svg+xml' = ANY(allowed_mime_types);
  IF v_axonimg_svg > 0 THEN
    RAISE EXCEPTION 'axon-images still has image/svg+xml in allowed_mime_types';
  END IF;
  RAISE NOTICE '[OK] axon-images no longer accepts image/svg+xml';

  -- 7. flashcard-images has MIME allowlist and size cap
  SELECT allowed_mime_types, file_size_limit INTO v_bucket_state
    FROM storage.buckets WHERE id = 'flashcard-images';
  IF v_bucket_state.allowed_mime_types IS NULL OR v_bucket_state.file_size_limit IS NULL THEN
    RAISE EXCEPTION 'flashcard-images missing allowed_mime_types or file_size_limit';
  END IF;
  RAISE NOTICE '[OK] flashcard-images has MIME allowlist (%) and size cap (%)',
    array_to_string(v_bucket_state.allowed_mime_types, ','),
    v_bucket_state.file_size_limit;

  -- 8. storage.objects dropped policies
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname IN ('Allow public read access to axon-images','Anon update axonmed','Anon upload axonmed')) THEN
    RAISE EXCEPTION 'One of the Phase-1-dropped storage.objects policies still exists';
  END IF;
  RAISE NOTICE '[OK] 3 storage.objects policies dropped';

  -- 9. ai_reading_config service_role bypass present (added by 20260418000002)
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public'
      AND tablename='ai_reading_config'
      AND policyname='ai_reading_config_service_role_all'
  ) THEN
    RAISE WARNING '[PENDING] ai_reading_config_service_role_all policy not yet applied (Phase-1 follow-up migration 20260418000002)';
  ELSE
    RAISE NOTICE '[OK] ai_reading_config has service_role FOR ALL bypass';
  END IF;

  RAISE NOTICE '═══════════════════════════════════════════════════════';
  RAISE NOTICE '[OK] Phase 1 post-apply verification passed all 9 checks';
  RAISE NOTICE '═══════════════════════════════════════════════════════';
END $$;

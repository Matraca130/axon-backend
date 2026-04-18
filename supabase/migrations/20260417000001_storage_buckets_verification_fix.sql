-- ============================================================================
-- Migration: Storage buckets — re-verify axon-images SELECT count using a
-- precise bucket_id match
-- Date: 2026-04-17
--
-- Problem:
--   The verification DO-block in 20260416000004_storage_tighten_public_buckets
--   used `qual LIKE '%axon-images%'`, which matches BOTH `axon-images` and
--   `axonmed-images` as substrings of the policy USING expression. The count
--   compared against the literal `1` is therefore racy: depending on what
--   public SELECT policies remain on `axonmed-images`, the prior verification
--   could either fire a spurious WARNING or mask a real duplicate.
--
--   The DROPs in the original migration were correct; only the verification
--   was wrong. This follow-up re-checks both buckets independently using a
--   pattern that requires the bucket_id literal to appear quoted in the qual
--   text, eliminating the substring overlap.
--
-- Idempotency:
--   This migration only emits NOTICE/WARNING via DO-blocks; it does not
--   modify any policies. Safe to re-run.
-- ============================================================================

DO $$
DECLARE
  v_count_axon_images    int;
  v_count_axonmed_images int;
BEGIN
  -- Match the bucket_id as a quoted literal inside the policy expression.
  -- Postgres pretty-prints qual with single-quoted bucket ids, so this
  -- pattern matches `bucket_id = 'axon-images'` but NOT `axonmed-images`.
  SELECT count(*) INTO v_count_axon_images
    FROM pg_policies
   WHERE schemaname = 'storage'
     AND tablename  = 'objects'
     AND cmd        = 'SELECT'
     AND 'public' = ANY(roles)
     AND qual LIKE '%''axon-images''%';

  SELECT count(*) INTO v_count_axonmed_images
    FROM pg_policies
   WHERE schemaname = 'storage'
     AND tablename  = 'objects'
     AND cmd        = 'SELECT'
     AND 'public' = ANY(roles)
     AND qual LIKE '%''axonmed-images''%';

  IF v_count_axon_images = 1 THEN
    RAISE NOTICE '[OK] storage.objects — axon-images has exactly 1 public SELECT policy';
  ELSE
    RAISE WARNING '[UNEXPECTED] storage.objects — axon-images has % public SELECT policies (expected 1)', v_count_axon_images;
  END IF;

  RAISE NOTICE '[INFO] storage.objects — axonmed-images public SELECT policy count: %', v_count_axonmed_images;
END; $$;

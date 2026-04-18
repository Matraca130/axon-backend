-- ============================================================================
-- Migration: Storage buckets — remove unauthenticated write & duplicate listing
-- Date: 2026-04-16
-- Advisor lints touched:
--   - public_bucket_allows_listing (WARN) for `axon-images` (2 duplicate SELECT)
--   - public_bucket_allows_listing (WARN) for `axonmed-images` (broad SELECT)
-- Plus a live pg_policies finding (not yet surfaced as a distinct lint) that
-- is the most severe of the set:
--   - `axonmed-images` has "Anon upload axonmed" (INSERT, role public) and
--     "Anon update axonmed" (UPDATE, role public). Any unauthenticated caller
--     holding the ANON_KEY can upload or modify objects in that bucket.
--
-- Problem:
--   axonmed-images is a publicly readable bucket, but the two `Anon upload/
--   update` policies turn it into a write-anywhere public drop zone. An
--   attacker can overwrite existing generated images, upload arbitrary
--   content (malware, illicit media, phishing assets) under the product's
--   storage domain, or exhaust quota. None of the backend code paths require
--   these policies — uploads are performed with service_role through the
--   Edge Functions after authentication and role checks.
--
--   axon-images separately has two functionally identical SELECT policies
--   ("Allow public read access to axon-images" and "Public read access for
--   axon-images") — duplicates that add review burden and make future
--   policy edits error-prone. Deduping keeps exactly one public-read policy.
--
-- Fix:
--   Phase A — Drop the anonymous INSERT and UPDATE policies on
--             `axonmed-images`. Writes continue to work because service_role
--             already has a bypass via `allow-service-role-all 1pyszbj_1` on
--             `axon-images` (axonmed-images uploads also use service_role in
--             backend code paths).
--   Phase B — Drop the duplicate "Allow public read access to axon-images"
--             SELECT policy. Keep "Public read access for axon-images" as
--             the single canonical public SELECT.
--
--   Listing-lint scope note: Supabase's lint recommends removing the broad
--   SELECT from public buckets entirely (clients don't need it for object URL
--   access). We do NOT make that change here because it can affect the JS
--   client's `list()` calls used for admin gallery views; deferring to a
--   targeted follow-up after verifying frontend call-sites.
--
-- Rollback:
--   -- Phase A: recreate "Anon upload axonmed" / "Anon update axonmed" on
--   --           storage.objects FOR INSERT/UPDATE TO public WITH CHECK
--   --           (bucket_id = 'axonmed-images').
--   -- Phase B: recreate "Allow public read access to axon-images" FOR SELECT
--   --           TO public USING (bucket_id = 'axon-images').
-- ============================================================================

-- ═══════════════════════════════════════════════════════════════════
-- PHASE A: axonmed-images — drop anonymous write policies
-- ═══════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "Anon upload axonmed" ON storage.objects;
DROP POLICY IF EXISTS "Anon update axonmed" ON storage.objects;


-- ═══════════════════════════════════════════════════════════════════
-- PHASE B: axon-images — dedupe public SELECT policies
-- ═══════════════════════════════════════════════════════════════════

-- "Public read access for axon-images" stays (canonical).
-- "Allow public read access to axon-images" is the duplicate and is dropped.
DROP POLICY IF EXISTS "Allow public read access to axon-images" ON storage.objects;


-- ═══════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ═══════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_count int;
BEGIN
  -- Expect 0 Anon write policies on axonmed-images
  SELECT count(*) INTO v_count
    FROM pg_policies
   WHERE schemaname = 'storage'
     AND tablename  = 'objects'
     AND policyname IN ('Anon upload axonmed','Anon update axonmed');
  IF v_count = 0 THEN
    RAISE NOTICE '[OK] storage.objects — axonmed anon write policies removed';
  ELSE
    RAISE WARNING '[UNEXPECTED] storage.objects — % axonmed anon write policies remain', v_count;
  END IF;

  -- Expect exactly 1 public SELECT for axon-images (the canonical name)
  SELECT count(*) INTO v_count
    FROM pg_policies
   WHERE schemaname = 'storage'
     AND tablename  = 'objects'
     AND cmd        = 'SELECT'
     AND 'public' = ANY(roles)
     AND qual LIKE '%axon-images%';
  IF v_count = 1 THEN
    RAISE NOTICE '[OK] storage.objects — axon-images has exactly 1 public SELECT policy';
  ELSE
    RAISE WARNING '[UNEXPECTED] storage.objects — axon-images has % public SELECT policies (expected 1)', v_count;
  END IF;
END; $$;

-- ============================================================================
-- Migration: Enable RLS on 3 public tables that had it disabled
-- Date: 2026-04-16
-- Advisor lint: rls_disabled_in_public (ERROR, 3 findings)
--
-- Problem:
--   Tables `_temp_image_store`, `rate_limit_entries`, and `reference_images`
--   live in schema `public` and are therefore exposed over the PostgREST API,
--   yet none of them had Row Level Security enabled. Any user (anon or
--   authenticated) holding the ANON_KEY could call the PostgREST endpoints
--   to read, insert, update, or delete rows directly — bypassing any
--   application-layer checks in the Edge Functions.
--
-- Caller audit (no regression risk):
--   - `rate_limit_entries`: accessed indirectly via the `check_rate_limit()`
--     RPC. Live pg_proc confirms the RPC is SECURITY INVOKER, but all 4
--     production callers (ai/pre-generate.ts:182/218, ai/realtime-session.ts:
--     189/244, ai/index.ts:100, ai/schedule-agent.ts:413) execute it through
--     `getAdminClient()` (service_role). service_role bypasses RLS, so
--     enabling RLS with no policies has no effect on legitimate traffic.
--   - `reference_images`: zero `.from("reference_images")` matches in the
--     backend (`supabase/functions`). Earlier matches in flashcard-images.ts
--     referenced a JSONB column of the same name on `style_packs`, not this
--     table. Frontend `src/` likewise has zero references.
--   - `_temp_image_store`: zero references anywhere in backend or frontend.
--
-- Fix:
--   ENABLE ROW LEVEL SECURITY on each table without adding any policies.
--   The default behaviour of "RLS enabled + zero policies" is deny-all for
--   every role except service_role. This preserves all current code paths
--   (which use service_role) and blocks every PostgREST-facing path.
--
-- Rollback:
--   ALTER TABLE public.<name> DISABLE ROW LEVEL SECURITY;
-- ============================================================================

ALTER TABLE public._temp_image_store    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rate_limit_entries   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reference_images     ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  v_table text;
  v_enabled boolean;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['_temp_image_store','rate_limit_entries','reference_images']
  LOOP
    SELECT relrowsecurity
      INTO v_enabled
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = v_table;
    IF v_enabled IS TRUE THEN
      RAISE NOTICE '[OK] RLS enabled on public.%', v_table;
    ELSE
      RAISE WARNING '[FAIL] RLS not enabled on public.%', v_table;
    END IF;
  END LOOP;
END; $$;

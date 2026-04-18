-- ============================================================================
-- Migration: Harden remaining SECURITY DEFINER functions with SET search_path
-- Date: 2026-04-16
--
-- Problem:
--   A live audit of pg_proc shows 4 SECURITY DEFINER functions in schema `public`
--   still lack `SET search_path = public, pg_temp`. Under the default role
--   search_path, an attacker with permission to create objects in any schema
--   earlier on the path can shadow unqualified references (e.g., `auth.uid()`,
--   `jsonb_build_object`, `count`, table names) and cause the definer-privileged
--   body to execute attacker code. Pinning search_path to `public, pg_temp`
--   closes this hijack vector.
--
-- Fix:
--   ALTER FUNCTION ... SET search_path = public, pg_temp — no body change,
--   so this is minimal, idempotent, and cannot regress behaviour.
--
-- Functions fixed (4 — missing search_path per live pg_proc audit on 2026-04-16):
--   1. award_xp(uuid, uuid, text, integer, numeric, text, text, uuid)
--   2. check_block_sync_health(uuid)
--   3. get_course_summary_ids(uuid)
--   4. rag_block_search(vector, double precision, integer, uuid[])
-- ============================================================================

ALTER FUNCTION public.award_xp(uuid, uuid, text, integer, numeric, text, text, uuid)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.check_block_sync_health(uuid)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.get_course_summary_ids(uuid)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.rag_block_search(vector, double precision, integer, uuid[])
  SET search_path = public, pg_temp;

-- Migration: Harden remaining SECURITY DEFINER functions (BH-ERR-015 completion)
--
-- Two functions created in 20260304 were missed by the 20260319 hardening migration:
--   1. get_institution_summary_ids — used by ingest.ts
--   2. resolve_summary_institution — used by search/trash scoping
--
-- Also covers search_scoped and trash_scoped from the same migration file,
-- which were noted as "SKIPPED — function does not exist" in the original
-- hardening pass but may have been created since.
--
-- ALTER FUNCTION only changes config, does NOT replace function body.
-- Idempotent: safe to run if functions already have search_path set.

-- ── get_institution_summary_ids (20260304000006) ──
ALTER FUNCTION get_institution_summary_ids(uuid)
  SET search_path = public, pg_temp;

-- ── resolve_summary_institution (20260304000003) ──
ALTER FUNCTION resolve_summary_institution(uuid)
  SET search_path = public, pg_temp;

-- ── search_scoped (20260304000003) — if it exists now ──
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'search_scoped') THEN
    EXECUTE 'ALTER FUNCTION search_scoped(text, uuid, int) SET search_path = public, pg_temp';
  END IF;
END $$;

-- ── trash_scoped (20260304000003) — if it exists now ──
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'trash_scoped') THEN
    EXECUTE 'ALTER FUNCTION trash_scoped(uuid) SET search_path = public, pg_temp';
  END IF;
END $$;

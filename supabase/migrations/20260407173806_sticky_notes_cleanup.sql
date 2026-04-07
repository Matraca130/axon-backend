-- Migration: sticky_notes cleanup — drop redundant index + add updated_at trigger
--
-- Q2 (audit finding): idx_sticky_notes_lookup (student_id, summary_id) was a
--    redundant btree on the same columns as sticky_notes_student_id_summary_id_key
--    (auto-created by the UNIQUE constraint). Two writes per row for zero benefit.
--
-- Q4 (audit finding): updated_at had no trigger so it only reflected creation
--    time unless a writer explicitly bumped it. The current backend route does,
--    but any out-of-band writer (Studio, MCP, future code) would forget.
--
-- This migration was applied directly to production via Supabase MCP under
-- version 20260407173806 BEFORE landing in the repo, as a smoke test of the
-- cleanup. The file uses that exact version timestamp so `supabase db push`
-- sees it as already-applied (idempotent skip) on the next workflow run.
--
-- Uses CREATE OR REPLACE TRIGGER (PG14+, project is on PG17) so we don't need
-- the destructive-SQL escape hatch for a DROP TRIGGER pattern.

-- ── Q2: drop the redundant lookup index ───────────────────
DROP INDEX IF EXISTS public.idx_sticky_notes_lookup;

-- ── Q4: shared updated_at trigger function ────────────────
-- Reusable for any future table that wants automatic updated_at maintenance.
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER sticky_notes_set_updated_at
  BEFORE UPDATE ON public.sticky_notes
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

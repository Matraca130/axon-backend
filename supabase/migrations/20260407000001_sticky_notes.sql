-- Migration: sticky_notes — Per-student "RAM-memory" scratchpad per summary
--
-- Stores a single free-form text note per (student, summary) pair, used by
-- the StickyNotesPanel component in the StudentSummaryReader. Each student
-- has at most one note per summary; the panel autosaves into this row via
-- POST /sticky-notes (atomic upsert on (student_id, summary_id)).

-- ── Table ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.sticky_notes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id  UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  summary_id  UUID NOT NULL REFERENCES public.summaries(id) ON DELETE CASCADE,
  content     TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, summary_id)
);

-- ── Index ────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_sticky_notes_lookup
  ON public.sticky_notes (student_id, summary_id);

-- ── RLS (mirrors reading_states / block_mastery_states pattern) ──────

ALTER TABLE public.sticky_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sticky_notes_own_select" ON public.sticky_notes
  FOR SELECT USING (student_id = auth.uid());

CREATE POLICY "sticky_notes_own_insert" ON public.sticky_notes
  FOR INSERT WITH CHECK (student_id = auth.uid());

CREATE POLICY "sticky_notes_own_update" ON public.sticky_notes
  FOR UPDATE USING (student_id = auth.uid());

CREATE POLICY "sticky_notes_own_delete" ON public.sticky_notes
  FOR DELETE USING (student_id = auth.uid());

CREATE POLICY "sticky_notes_service_role_all" ON public.sticky_notes
  FOR ALL USING (auth.role() = 'service_role');

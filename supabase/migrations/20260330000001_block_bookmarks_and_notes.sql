-- ============================================================================
-- Migration: block_bookmarks + block_notes tables
-- Student-owned tools for summary blocks (bookmarks and notes)
-- Date: 2026-03-30
--
-- Tables:
--   block_bookmarks — toggle bookmarks on summary blocks (create/delete only)
--   block_notes     — rich notes attached to summary blocks (soft-delete)
--
-- RLS: student_id = auth.uid() pattern (same as text_annotations, video_notes)
-- ============================================================================

-- ══════════════════════════════════════════════════════════════════════════════
-- 1. BLOCK BOOKMARKS
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE block_bookmarks (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  summary_id  uuid        NOT NULL REFERENCES summaries(id)      ON DELETE CASCADE,
  block_id    uuid        NOT NULL REFERENCES summary_blocks(id)  ON DELETE CASCADE,
  student_id  uuid        NOT NULL REFERENCES auth.users(id)      ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_id, block_id)
);

CREATE INDEX idx_block_bookmarks_student_summary
  ON block_bookmarks(student_id, summary_id);

-- RLS
ALTER TABLE block_bookmarks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "block_bm_own_select"
  ON block_bookmarks FOR SELECT
  USING (student_id = auth.uid());

CREATE POLICY "block_bm_own_insert"
  ON block_bookmarks FOR INSERT
  WITH CHECK (student_id = auth.uid());

CREATE POLICY "block_bm_own_delete"
  ON block_bookmarks FOR DELETE
  USING (student_id = auth.uid());

-- No UPDATE policy — bookmarks are create/delete only

CREATE POLICY "block_bm_service_role_all"
  ON block_bookmarks FOR ALL
  USING (auth.role() = 'service_role');

-- ══════════════════════════════════════════════════════════════════════════════
-- 2. BLOCK NOTES
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE block_notes (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  summary_id  uuid        NOT NULL REFERENCES summaries(id)      ON DELETE CASCADE,
  block_id    uuid        NOT NULL REFERENCES summary_blocks(id)  ON DELETE CASCADE,
  student_id  uuid        NOT NULL REFERENCES auth.users(id)      ON DELETE CASCADE,
  text        text        NOT NULL,
  color       varchar(20) NOT NULL DEFAULT 'yellow',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz DEFAULT NULL
);

CREATE INDEX idx_block_notes_student_summary
  ON block_notes(student_id, summary_id);

-- RLS
ALTER TABLE block_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "block_notes_own_select"
  ON block_notes FOR SELECT
  USING (student_id = auth.uid());

CREATE POLICY "block_notes_own_insert"
  ON block_notes FOR INSERT
  WITH CHECK (student_id = auth.uid());

CREATE POLICY "block_notes_own_update"
  ON block_notes FOR UPDATE
  USING (student_id = auth.uid());

CREATE POLICY "block_notes_own_delete"
  ON block_notes FOR DELETE
  USING (student_id = auth.uid());

CREATE POLICY "block_notes_service_role_all"
  ON block_notes FOR ALL
  USING (auth.role() = 'service_role');

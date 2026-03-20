-- ============================================================
-- Migration: Flashcard Status Column
-- Date: 2026-03-12
-- Purpose: Add status column to flashcards table for
--          published/draft/archived workflow.
--
-- Values: 'published' (default) | 'draft' | 'archived'
-- CHECK constraint ensures only valid values.
-- Partial indexes for common query patterns.
-- ============================================================

-- Add status column with default 'published'
ALTER TABLE flashcards
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'published';

-- CHECK constraint for valid values
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'flashcards_status_check'
  ) THEN
    ALTER TABLE flashcards
      ADD CONSTRAINT flashcards_status_check
      CHECK (status IN ('published', 'draft', 'archived'));
  END IF;
END
$$;

-- Partial index for published flashcards (most common query)
CREATE INDEX IF NOT EXISTS idx_flashcards_published
  ON flashcards(summary_id)
  WHERE status = 'published' AND is_active = true AND deleted_at IS NULL;

-- Partial index for draft flashcards (professor editing)
CREATE INDEX IF NOT EXISTS idx_flashcards_draft
  ON flashcards(summary_id)
  WHERE status = 'draft' AND deleted_at IS NULL;

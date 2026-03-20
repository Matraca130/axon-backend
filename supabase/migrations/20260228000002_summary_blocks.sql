-- ============================================================
-- Migration: 20260228_02_summary_blocks.sql
-- Purpose:   Create summary_blocks table for Smart Reader
-- Column:    "type" (NOT "block_type" — see Guidelines.md)
-- ============================================================

-- 1. Create table
CREATE TABLE IF NOT EXISTS public.summary_blocks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  summary_id  uuid NOT NULL REFERENCES public.summaries(id) ON DELETE CASCADE,
  type        text NOT NULL DEFAULT 'paragraph',
  content     text NOT NULL DEFAULT '',
  heading_text  text,
  heading_level smallint,
  order_index integer NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.summary_blocks IS 'Blocks of a summary for the Smart Reader. Each block is a section (heading, paragraph, list, image, etc.).';
COMMENT ON COLUMN public.summary_blocks.type IS 'Block type: heading, paragraph, list, image, callout, etc. Uses "type" not "block_type".';
COMMENT ON COLUMN public.summary_blocks.heading_text IS 'Plain text of the heading (for outline/TOC). NULL for non-heading blocks.';
COMMENT ON COLUMN public.summary_blocks.heading_level IS 'Heading level (1-6). NULL for non-heading blocks.';

-- 2. Indexes
CREATE INDEX IF NOT EXISTS idx_summary_blocks_summary_id
  ON public.summary_blocks(summary_id);

CREATE INDEX IF NOT EXISTS idx_summary_blocks_order
  ON public.summary_blocks(summary_id, order_index)
  WHERE is_active = true;

-- 3. RLS
ALTER TABLE public.summary_blocks ENABLE ROW LEVEL SECURITY;

-- Professors: full access via parent summary's created_by
CREATE POLICY "Professors manage summary_blocks"
  ON public.summary_blocks
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.summaries s
      WHERE s.id = summary_blocks.summary_id
        AND s.created_by = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.summaries s
      WHERE s.id = summary_blocks.summary_id
        AND s.created_by = auth.uid()
    )
  );

-- Students: read-only access to active blocks
CREATE POLICY "Students read active summary_blocks"
  ON public.summary_blocks
  FOR SELECT
  USING (
    is_active = true
    AND EXISTS (
      SELECT 1 FROM public.summaries s
      WHERE s.id = summary_blocks.summary_id
        AND s.deleted_at IS NULL
    )
  );

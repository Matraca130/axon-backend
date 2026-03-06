-- Migration: 20260310_01_pdf_source_columns.sql
-- Fase 7 (Feature #13): PDF Ingestion support
--
-- Adds source tracking columns to summaries table.
-- Decision D51: TEXT type (not ENUM) for source_type.
-- All existing summaries get source_type='text' (the default).

-- Step 1: Add columns

ALTER TABLE public.summaries
  ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'text';

ALTER TABLE public.summaries
  ADD COLUMN IF NOT EXISTS source_file_path TEXT;

ALTER TABLE public.summaries
  ADD COLUMN IF NOT EXISTS source_file_name TEXT;

-- Step 2: Partial index for non-text source types

CREATE INDEX IF NOT EXISTS idx_summaries_source_type
  ON public.summaries (source_type)
  WHERE source_type <> 'text';

-- Step 3: Column comments (single-line to avoid SQL Editor bug)

COMMENT ON COLUMN public.summaries.source_type IS 'Content origin: text, pdf, url';
COMMENT ON COLUMN public.summaries.source_file_path IS 'Storage path for uploaded source files';
COMMENT ON COLUMN public.summaries.source_file_name IS 'Original filename of uploaded source';

-- Step 4: Create Storage bucket for PDF sources

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'pdf-sources',
  'pdf-sources',
  false,
  10485760,
  ARRAY['application/pdf']
)
ON CONFLICT (id) DO NOTHING;

-- Step 5: Storage RLS policies
-- F-5 FIX: DROP IF EXISTS + CREATE (PG has no CREATE POLICY IF NOT EXISTS)
-- F-6 FIX: Table is 'memberships', not 'institution_members'

DROP POLICY IF EXISTS "pdf_sources_insert_policy" ON storage.objects;
CREATE POLICY "pdf_sources_insert_policy"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'pdf-sources'
    AND (storage.foldername(name))[1] IN (
      SELECT m.institution_id::text
      FROM public.memberships m
      WHERE m.user_id = auth.uid()
        AND m.is_active = true
        AND m.role IN ('owner', 'admin', 'professor')
    )
  );

DROP POLICY IF EXISTS "pdf_sources_select_policy" ON storage.objects;
CREATE POLICY "pdf_sources_select_policy"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'pdf-sources'
    AND (storage.foldername(name))[1] IN (
      SELECT m.institution_id::text
      FROM public.memberships m
      WHERE m.user_id = auth.uid()
        AND m.is_active = true
        AND m.role IN ('owner', 'admin', 'professor')
    )
  );

DROP POLICY IF EXISTS "pdf_sources_delete_policy" ON storage.objects;
CREATE POLICY "pdf_sources_delete_policy"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'pdf-sources'
    AND (storage.foldername(name))[1] IN (
      SELECT m.institution_id::text
      FROM public.memberships m
      WHERE m.user_id = auth.uid()
        AND m.is_active = true
        AND m.role IN ('owner', 'admin')
    )
  );

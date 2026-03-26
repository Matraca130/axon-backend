-- ============================================================
-- Migration: 20260326_03_summary_blocks_schema_sync
-- Purpose:   Sync summary_blocks schema with production state.
--            The original migration (20260228_02) created the table
--            with content as TEXT and missing columns. Production
--            was patched manually. This migration is idempotent —
--            safe to run on both fresh DBs and production.
-- ============================================================

-- 1. Change content: text → jsonb (production already has this)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'summary_blocks'
      AND column_name = 'content'
      AND data_type = 'text'
  ) THEN
    -- Convert existing text content to jsonb
    ALTER TABLE public.summary_blocks
      ALTER COLUMN content TYPE jsonb USING content::jsonb;
    ALTER TABLE public.summary_blocks
      ALTER COLUMN content SET DEFAULT '{}'::jsonb;
    RAISE NOTICE '[OK] summary_blocks.content: text → jsonb';
  ELSE
    RAISE NOTICE '[SKIP] summary_blocks.content already jsonb';
  END IF;
END; $$;

-- 2. Fix default type: 'paragraph' → 'prose' (matches frontend EduBlockType)
ALTER TABLE public.summary_blocks
  ALTER COLUMN type SET DEFAULT 'prose';

-- 3. Add missing columns (idempotent)
DO $$
BEGIN
  -- style (jsonb)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'summary_blocks' AND column_name = 'style'
  ) THEN
    ALTER TABLE public.summary_blocks ADD COLUMN style jsonb DEFAULT '{}'::jsonb;
    RAISE NOTICE '[OK] Added summary_blocks.style';
  ELSE
    RAISE NOTICE '[SKIP] summary_blocks.style already exists';
  END IF;

  -- metadata (jsonb)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'summary_blocks' AND column_name = 'metadata'
  ) THEN
    ALTER TABLE public.summary_blocks ADD COLUMN metadata jsonb DEFAULT '{}'::jsonb;
    RAISE NOTICE '[OK] Added summary_blocks.metadata';
  ELSE
    RAISE NOTICE '[SKIP] summary_blocks.metadata already exists';
  END IF;

  -- updated_at (timestamptz)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'summary_blocks' AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE public.summary_blocks ADD COLUMN updated_at timestamptz DEFAULT now();
    RAISE NOTICE '[OK] Added summary_blocks.updated_at';
  ELSE
    RAISE NOTICE '[SKIP] summary_blocks.updated_at already exists';
  END IF;

  -- created_by (uuid)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'summary_blocks' AND column_name = 'created_by'
  ) THEN
    ALTER TABLE public.summary_blocks ADD COLUMN created_by uuid;
    RAISE NOTICE '[OK] Added summary_blocks.created_by';
  ELSE
    RAISE NOTICE '[SKIP] summary_blocks.created_by already exists';
  END IF;

  -- embedding (vector 1536)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'summary_blocks' AND column_name = 'embedding'
  ) THEN
    ALTER TABLE public.summary_blocks ADD COLUMN embedding vector(1536);
    RAISE NOTICE '[OK] Added summary_blocks.embedding';
  ELSE
    RAISE NOTICE '[SKIP] summary_blocks.embedding already exists';
  END IF;
END; $$;

-- 4. Index on embedding for vector search (idempotent)
CREATE INDEX IF NOT EXISTS idx_summary_blocks_embedding
  ON public.summary_blocks USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

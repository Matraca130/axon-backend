-- ============================================================
-- Migration: Add response_time_ms to reviews table
-- Date: 2026-03-04
-- Purpose: M-2 FIX — Frontend already sends response_time_ms
--          on POST /reviews, but the column didn't exist.
--          Backend code now extracts and inserts it (PR #12).
--
-- Safety:
--   - Nullable column, no default → existing rows get NULL
--   - No NOT NULL constraint → backward compatible
--   - Idempotent: IF NOT EXISTS guard
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'reviews'
      AND column_name  = 'response_time_ms'
  ) THEN
    ALTER TABLE public.reviews
      ADD COLUMN response_time_ms integer;

    COMMENT ON COLUMN public.reviews.response_time_ms
      IS 'Time in milliseconds the student spent before rating the card. Nullable for historical rows.';
  END IF;
END
$$;

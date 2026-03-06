-- ============================================================================
-- Migration: Add chunking metadata columns
-- Date: 2026-03-07
-- Purpose: Track chunking strategy per chunk + last chunking timestamp per summary
--
-- New columns:
--   chunks.chunk_strategy      TEXT NOT NULL DEFAULT 'recursive'
--   summaries.last_chunked_at   TIMESTAMPTZ
--
-- Fase 5, sub-task 5.4 — Issue #30
-- ============================================================================

-- ── 1. chunks.chunk_strategy ────────────────────────────────────────
--
-- Records which splitting algorithm produced each chunk.
-- Current value: 'recursive' (Fase 5 chunker.ts)
-- Future value:  'semantic'  (Fase 8 — semantic chunking)
--
-- DEFAULT ensures existing rows and new inserts from the current
-- chunker are automatically labelled without code changes.

ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS chunk_strategy TEXT NOT NULL DEFAULT 'recursive';

COMMENT ON COLUMN chunks.chunk_strategy IS
  'Splitting algorithm that produced this chunk: recursive | semantic';

-- ── 2. summaries.last_chunked_at ────────────────────────────────────
--
-- Timestamp of the last time this summary was chunked.
-- NULL means the summary has never been chunked.
--
-- The auto-ingest pipeline uses this to detect stale chunks:
--   WHERE last_chunked_at IS NULL
--      OR last_chunked_at < updated_at
--
-- This avoids re-chunking summaries whose content hasn't changed.

ALTER TABLE summaries
  ADD COLUMN IF NOT EXISTS last_chunked_at TIMESTAMPTZ;

COMMENT ON COLUMN summaries.last_chunked_at IS
  'When this summary was last chunked for RAG embedding. NULL = never chunked.';

-- ── 3. Index for "needs re-chunking" queries ────────────────────────
--
-- The auto-ingest cron/trigger will query:
--   SELECT id FROM summaries
--   WHERE last_chunked_at IS NULL OR last_chunked_at < updated_at
--
-- A partial index on NULL values is most efficient since most
-- summaries will eventually have a non-NULL last_chunked_at.

CREATE INDEX IF NOT EXISTS idx_summaries_needs_chunking
  ON summaries (id)
  WHERE last_chunked_at IS NULL;

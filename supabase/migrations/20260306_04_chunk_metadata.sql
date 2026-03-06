-- ============================================================
-- Migration: 20260306_04_chunk_metadata.sql
-- Fase 5 — Chunking inteligente + Auto-ingest
--
-- Adds:
--   chunks.chunk_strategy   — how this chunk was created
--   summaries.last_chunked_at — when auto-chunk last ran
--   Index for finding summaries that need re-chunking
-- ============================================================

-- Track chunking strategy per chunk (manual, recursive, semantic)
ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS chunk_strategy TEXT DEFAULT 'manual';

-- Track when auto-ingest last ran per summary
ALTER TABLE summaries
  ADD COLUMN IF NOT EXISTS last_chunked_at TIMESTAMPTZ;

-- Index for finding summaries that need re-chunking
CREATE INDEX IF NOT EXISTS idx_summaries_needs_chunking
  ON summaries (institution_id)
  WHERE last_chunked_at IS NULL AND deleted_at IS NULL AND is_active = TRUE;

COMMENT ON COLUMN chunks.chunk_strategy IS 'How this chunk was created: manual, recursive, semantic';
COMMENT ON COLUMN summaries.last_chunked_at IS 'Last time auto-chunk ran for this summary';

-- Add content_hash column to chunks table.
-- Used by auto-ingest to skip re-chunking + re-embedding when
-- the source summary content has not changed (SHA-256 of title+markdown).

ALTER TABLE chunks ADD COLUMN IF NOT EXISTS content_hash TEXT;

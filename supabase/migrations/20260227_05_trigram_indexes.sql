-- ============================================================
-- O-4: Trigram indexes for ILIKE search performance
-- ============================================================
-- Requires pg_trgm extension for GIN trigram operator class.
-- These indexes convert ilike/similar_to patterns from sequential
-- scans to index scans once table data volume grows.
--
-- Affected queries: GET /search (routes-search.ts)
--   - summaries: title, content_markdown
--   - keywords: name, definition
--   - videos: title
--
-- Safe to run: IF NOT EXISTS prevents errors on re-run.
-- Impact: INSERT/UPDATE slightly slower (GIN maintenance),
--         SELECT with ilike dramatically faster at >1000 rows.
--
-- Status: PENDING — run in Supabase SQL Editor
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_summaries_title_trgm
  ON summaries USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_summaries_content_trgm
  ON summaries USING gin (content_markdown gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_keywords_name_trgm
  ON keywords USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_keywords_definition_trgm
  ON keywords USING gin (definition gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_videos_title_trgm
  ON videos USING gin (title gin_trgm_ops);

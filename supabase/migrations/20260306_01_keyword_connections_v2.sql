-- ============================================================
-- Migration: Keyword Connections v2 — add type + source columns
-- Date: 2026-03-06
-- Cherry-picked from PR #20 (feat/kc-v2-search-and-types)
--
-- Adds two optional columns to support richer keyword connections:
--   - connection_type: structured category (vs free-text 'relationship')
--   - source_keyword_id: which keyword initiated the connection
--     (needed because keyword_a_id/keyword_b_id are canonically sorted)
--
-- Backward compatible: both columns are nullable.
-- Idempotent: uses ADD COLUMN IF NOT EXISTS.
--
-- Rollback:
--   ALTER TABLE keyword_connections DROP COLUMN IF EXISTS connection_type;
--   ALTER TABLE keyword_connections DROP COLUMN IF EXISTS source_keyword_id;
--   DROP INDEX IF EXISTS idx_kc_source_keyword;
-- ============================================================

-- 1. Structured connection type (enum-like, validated in app layer)
ALTER TABLE keyword_connections
  ADD COLUMN IF NOT EXISTS connection_type TEXT;

COMMENT ON COLUMN keyword_connections.connection_type IS
  'Structured connection category: prerequisito, causa-efecto, mecanismo, '
  'dx-diferencial, tratamiento, manifestacion, regulacion, contraste, '
  'componente, asociacion. Distinct from relationship (free-text label). '
  'Validated in app layer (VALID_CONNECTION_TYPES), not DB enum.';

-- 2. Source keyword (which keyword the user was viewing when they created the connection)
ALTER TABLE keyword_connections
  ADD COLUMN IF NOT EXISTS source_keyword_id UUID REFERENCES keywords(id) ON DELETE SET NULL;

COMMENT ON COLUMN keyword_connections.source_keyword_id IS
  'The keyword from which this connection was initiated. '
  'keyword_a_id/keyword_b_id are canonically sorted (a < b), so directionality is lost. '
  'This column preserves it for directional types (prerequisito, causa-efecto, etc.).';

-- 3. Index for efficient lookups by source keyword
CREATE INDEX IF NOT EXISTS idx_kc_source_keyword
  ON keyword_connections (source_keyword_id)
  WHERE source_keyword_id IS NOT NULL;

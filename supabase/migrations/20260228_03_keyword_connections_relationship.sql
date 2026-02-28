-- ============================================================
-- Migration: Add relationship column to keyword_connections
--
-- The backend route (routes-content.tsx) already sends
-- `relationship` on POST /keyword-connections, but the column
-- was never created. This fixes the mismatch.
--
-- Safe to run: ALTER TABLE ADD COLUMN IF NOT EXISTS is idempotent.
-- ============================================================

ALTER TABLE keyword_connections
  ADD COLUMN IF NOT EXISTS relationship TEXT;

COMMENT ON COLUMN keyword_connections.relationship IS
  'Optional label for the connection type, e.g. causa-efecto, parte-de, complemento';

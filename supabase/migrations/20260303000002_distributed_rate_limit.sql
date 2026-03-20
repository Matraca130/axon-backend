-- ============================================================
-- Migration: Distributed Rate Limiting via PostgreSQL
-- Date: 2026-03-03
-- Purpose: Replace in-memory Map rate limiter with DB-backed
--          solution that works across multiple edge isolates.
--
-- Architecture:
--   - Table stores rate limit entries keyed by token prefix
--   - RPC function atomically checks and increments counters
--   - Expired entries cleaned up lazily by the RPC itself
--   - Works correctly with multiple Deno isolates
--
-- Performance:
--   - Single round-trip per request (RPC call)
--   - Index on expires_at for efficient cleanup
--   - Unlogged table for maximum write throughput
-- ============================================================

-- Use UNLOGGED table: rate limit data is ephemeral,
-- no need for WAL overhead. Data is lost on crash but that's fine.
CREATE UNLOGGED TABLE IF NOT EXISTS rate_limit_entries (
  key        TEXT PRIMARY KEY,
  count      INTEGER NOT NULL DEFAULT 1,
  expires_at TIMESTAMPTZ NOT NULL
);

-- Index for efficient cleanup of expired entries
CREATE INDEX IF NOT EXISTS idx_rate_limit_expires
  ON rate_limit_entries (expires_at);

-- ============================================================
-- RPC: check_rate_limit
-- Atomically checks and increments the rate limit counter.
-- Returns: { allowed: boolean, current: integer, retry_after_ms: integer }
-- ============================================================
CREATE OR REPLACE FUNCTION check_rate_limit(
  p_key TEXT,
  p_max_requests INTEGER DEFAULT 120,
  p_window_ms INTEGER DEFAULT 60000
)
RETURNS JSON
LANGUAGE plpgsql
AS $$
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
  v_expires TIMESTAMPTZ := v_now + (p_window_ms || ' milliseconds')::INTERVAL;
  v_entry RECORD;
  v_count INTEGER;
  v_retry_after_ms INTEGER;
BEGIN
  -- Lazy cleanup: remove expired entries (limit 100 to avoid long locks)
  DELETE FROM rate_limit_entries
  WHERE expires_at < v_now
  AND ctid IN (
    SELECT ctid FROM rate_limit_entries
    WHERE expires_at < v_now
    LIMIT 100
  );

  -- Atomic upsert: insert or increment
  INSERT INTO rate_limit_entries (key, count, expires_at)
  VALUES (p_key, 1, v_expires)
  ON CONFLICT (key) DO UPDATE SET
    count = CASE
      WHEN rate_limit_entries.expires_at < v_now THEN 1  -- Window expired, reset
      ELSE rate_limit_entries.count + 1                   -- Increment
    END,
    expires_at = CASE
      WHEN rate_limit_entries.expires_at < v_now THEN v_expires  -- New window
      ELSE rate_limit_entries.expires_at                          -- Keep existing
    END
  RETURNING count, expires_at INTO v_entry;

  v_count := v_entry.count;

  IF v_count > p_max_requests THEN
    v_retry_after_ms := GREATEST(0,
      EXTRACT(EPOCH FROM (v_entry.expires_at - v_now))::INTEGER * 1000
    );
    RETURN json_build_object(
      'allowed', false,
      'current', v_count,
      'retry_after_ms', v_retry_after_ms
    );
  END IF;

  RETURN json_build_object(
    'allowed', true,
    'current', v_count,
    'retry_after_ms', 0
  );
END;
$$;

-- ============================================================
-- Maintenance function: bulk cleanup (can be called via pg_cron)
-- ============================================================
CREATE OR REPLACE FUNCTION cleanup_expired_rate_limits()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM rate_limit_entries
  WHERE expires_at < clock_timestamp();
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

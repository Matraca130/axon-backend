-- ============================================================
-- O-7: Webhook idempotency table
-- ============================================================
-- Tracks processed webhook event IDs from Stripe and Mux to
-- prevent double-processing on delivery retries.
--
-- Stripe retries: up to 3 days, with exponential backoff.
-- Mux retries: up to 24 hours.
-- Retention: 7 days (cleanup via scheduled job or manual DELETE).
--
-- Run in: Supabase SQL Editor
-- Rollback: DROP TABLE IF EXISTS processed_webhook_events;
-- ============================================================

CREATE TABLE IF NOT EXISTS processed_webhook_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       TEXT NOT NULL,
  event_type     TEXT NOT NULL,
  source         TEXT NOT NULL DEFAULT 'stripe',  -- 'stripe' | 'mux'
  processed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique constraint: same event can only be processed once
CREATE UNIQUE INDEX IF NOT EXISTS idx_pwe_event_id_source
  ON processed_webhook_events (event_id, source);

-- Cleanup index: efficiently delete events older than 7 days
-- DELETE FROM processed_webhook_events
-- WHERE processed_at < NOW() - INTERVAL '7 days';
CREATE INDEX IF NOT EXISTS idx_pwe_processed_at
  ON processed_webhook_events (processed_at);

-- Verification query:
-- SELECT tablename FROM pg_tables
-- WHERE tablename = 'processed_webhook_events';

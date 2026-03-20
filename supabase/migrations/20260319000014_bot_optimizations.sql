-- ============================================================================
-- Migration: Bot Optimizations (Ronda 2 Group J)
-- Date: 2026-03-19
-- Purpose:
--   8.1: Add channel column to whatsapp_jobs for Telegram async queue support
--   8.3: Add phone_lookup_hash to whatsapp_links for O(1) user lookup
--
-- Changes:
--   1. whatsapp_jobs: ADD channel column (default 'whatsapp' for backward compat)
--   2. whatsapp_jobs: Index on (channel, status, created_at) for per-channel polling
--   3. whatsapp_links: ADD phone_lookup_hash column
--   4. whatsapp_links: Partial index on phone_lookup_hash WHERE is_active
--   5. pg_cron: Schedule Telegram job processor
-- ============================================================================

-- 1. whatsapp_jobs: channel column for multi-bot support

ALTER TABLE whatsapp_jobs
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'whatsapp'
  CHECK (channel IN ('whatsapp', 'telegram'));

-- Index for per-channel pending job polling (both WhatsApp and Telegram queues)
CREATE INDEX IF NOT EXISTS idx_wa_jobs_channel_pending
  ON whatsapp_jobs (channel, created_at ASC)
  WHERE status = 'pending';

-- 2. whatsapp_links: phone_lookup_hash for O(1) lookup

-- Secondary hash using global app secret (no per-user salt) for direct indexed lookup.
-- The original phone_hash (with per-user salt) is kept for verification.
ALTER TABLE whatsapp_links
  ADD COLUMN IF NOT EXISTS phone_lookup_hash text;

-- Partial index for fast O(1) lookup on active links
CREATE INDEX IF NOT EXISTS idx_whatsapp_links_lookup
  ON whatsapp_links (phone_lookup_hash)
  WHERE is_active = true;

-- 3. pg_cron: Telegram job processor (every minute)

SELECT cron.schedule(
  'tg-job-processor',
  '* * * * *',
  $$SELECT net.http_post(
    url := current_setting('app.settings.edge_function_url') || '/telegram/process-queue',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )$$
);

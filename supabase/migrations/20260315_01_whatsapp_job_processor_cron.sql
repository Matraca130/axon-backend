-- ============================================================================
-- Migration: WhatsApp job processor + cleanup cron jobs
-- Date: 2026-03-15
-- Purpose: Automated processing of async WhatsApp jobs (generate_content,
--          generate_weekly_report) and cleanup of completed/failed jobs.
--
-- N5 FIX: Fire-and-forget in handler.ts was the only trigger for job
-- processing. If it failed (cold start, crash), jobs stayed pending forever.
-- This migration adds a pg_cron job that calls the process-queue endpoint
-- every minute via pg_net HTTP POST.
--
-- N6 FIX: whatsapp_jobs had no retention. Completed/failed jobs accumulated
-- indefinitely. Added 7-day retention cleanup.
--
-- Prerequisites:
--   - pg_cron extension (confirmed available)
--   - pg_net extension (for HTTP POST from SQL)
--   - WHATSAPP_ENABLED=true in secrets
--   - process-queue endpoint requires service_role_key auth (N1 FIX)
-- ============================================================================

-- ═══════════════════════════════════════════════════════════════
-- 1. Job Processor — every minute, process up to 5 pending jobs
-- ═══════════════════════════════════════════════════════════════
--
-- NOTE: The URL and service_role_key must be configured per environment.
-- Supabase provides these as database settings accessible via current_setting().
--
-- For Supabase hosted projects, the Edge Function URL follows the pattern:
--   https://<project-ref>.supabase.co/functions/v1/server/whatsapp/process-queue
--
-- pg_net must be enabled. If not available, this migration is a no-op
-- and processing relies on the fire-and-forget in handler.ts.

DO $$
BEGIN
  -- Check if pg_net extension is available for HTTP calls
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_net') THEN
    CREATE EXTENSION IF NOT EXISTS pg_net;

    -- Schedule job processor every minute
    PERFORM cron.schedule(
      'wa-job-processor',
      '* * * * *',
      $$
      SELECT net.http_post(
        url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_functions_url') || '/server/whatsapp/process-queue',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
        ),
        body := '{}'::jsonb
      );
      $$
    );

    RAISE NOTICE 'pg_net available: wa-job-processor cron scheduled (every minute).';
  ELSE
    RAISE NOTICE 'pg_net not available. Job processing relies on handler.ts fire-and-forget only.';
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════
-- 2. Job Cleanup — daily at 04:00 UTC, remove old completed/failed jobs
-- ═══════════════════════════════════════════════════════════════
--
-- N6 FIX: Without this, done/failed jobs accumulate indefinitely.
-- 7-day retention gives enough time for debugging failed jobs.

SELECT cron.schedule(
  'wa-job-retention',
  '0 4 * * *',
  $$DELETE FROM whatsapp_jobs
    WHERE status IN ('done', 'failed')
    AND created_at < now() - interval '7 days'$$
);


-- ── Verification queries ──────────────────────────────────────
-- SELECT jobname, schedule, command FROM cron.job WHERE jobname LIKE 'wa-%';
-- SELECT count(*) FROM whatsapp_jobs WHERE status = 'pending';

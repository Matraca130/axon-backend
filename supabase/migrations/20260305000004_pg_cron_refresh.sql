-- ============================================================================
-- Migration: Schedule periodic refresh of mv_student_knowledge_profile
-- Date: 2026-03-05
-- Purpose: Keep the materialized view updated for adaptive AI prompts
--
-- Prerequisites:
--   - pg_cron extension enabled in Supabase Dashboard > Database > Extensions
--   - Migration 01 (mv_student_knowledge_profile) already applied
--
-- LA-08 FIX: Automates the matview refresh that was previously manual-only.
-- Uses CONCURRENTLY to avoid locking reads during refresh.
-- Requires the unique index idx_mv_skp_pk from Migration 01.
-- ============================================================================

-- Refresh every 2 minutes (adaptive AI needs reasonably fresh data)
-- Wrapped in existence check to avoid errors if MV is dropped/renamed.
SELECT cron.schedule(
  'refresh-mv-knowledge-profile',
  '*/2 * * * *',
  $$DO $guard$ BEGIN IF EXISTS (SELECT 1 FROM pg_matviews WHERE matviewname = 'mv_student_knowledge_profile') THEN REFRESH MATERIALIZED VIEW CONCURRENTLY mv_student_knowledge_profile; END IF; END $guard$;$$
);

-- Initial population (safe to run even if already refreshed)
DO $guard$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_matviews WHERE matviewname = 'mv_student_knowledge_profile') THEN
    REFRESH MATERIALIZED VIEW mv_student_knowledge_profile;
  END IF;
END $guard$;

-- Verify the job was created:
-- SELECT * FROM cron.job WHERE jobname = 'refresh-mv-knowledge-profile';

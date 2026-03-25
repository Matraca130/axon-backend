-- ============================================================================
-- Migration: Gamification pg_cron jobs
-- Date: 2026-03-25
-- Purpose: Schedule daily XP reset, weekly XP reset, and leaderboard refresh.
--
-- These jobs were documented in GAMIFICATION_AUDIT.md and GAMIFICATION_MAP.md
-- but the migration creating them was missing.
--
-- Race-condition guard on xp_today / xp_this_week resets:
--   Only reset rows whose updated_at is before today (or Monday for weekly).
--   This prevents zeroing out XP that was just awarded at midnight by a
--   concurrent award_xp() call.
-- ============================================================================

-- ═══════════════════════════════════════════════════════════════
-- 1. Daily XP reset — midnight UTC
--    Guard: only reset rows not updated today (avoids race with award_xp)
-- ═══════════════════════════════════════════════════════════════
SELECT cron.schedule(
  'reset-daily-xp',
  '0 0 * * *',
  $$UPDATE student_xp
      SET xp_today = 0,
          updated_at = now()
    WHERE updated_at < date_trunc('day', now())$$
);

-- ═══════════════════════════════════════════════════════════════
-- 2. Weekly XP reset — Monday 00:00 UTC
--    Guard: only reset rows not updated this week
-- ═══════════════════════════════════════════════════════════════
SELECT cron.schedule(
  'reset-weekly-xp',
  '0 0 * * 1',
  $$UPDATE student_xp
      SET xp_this_week = 0,
          updated_at = now()
    WHERE updated_at < date_trunc('week', now())$$
);

-- ═══════════════════════════════════════════════════════════════
-- 3. Leaderboard MV refresh — hourly
--    Guard: check if MV exists before refreshing
-- ═══════════════════════════════════════════════════════════════
SELECT cron.schedule(
  'refresh-leaderboard',
  '0 * * * *',
  $$DO $guard$ BEGIN IF EXISTS (SELECT 1 FROM pg_matviews WHERE matviewname = 'leaderboard_weekly') THEN REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_weekly; END IF; END $guard$;$$
);

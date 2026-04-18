-- ============================================================================
-- Migration: 20260418000002_security_rls_batch_fixes.sql
-- Date: 2026-04-18
-- Purpose: Fix 7 RLS findings from security audit (batch remediation).
--
-- Fixes applied:
--   H-03  exam_events       — DROP broken exam_professor_read policy that
--                              references non-existent course_enrollments
--                              table; recreate using memberships.
--   M-02  summary_blocks    — Scope student SELECT by institution via
--                              summaries.institution_id + memberships.
--   M-03  weekly_reports    — Add missing UPDATE/DELETE own policies.
--   M-04  finals_periods    — Add missing service_role ALL policy.
--   M-05  exam_schedules    — Add missing service_role ALL policy.
--   L-01  video_views       — Add missing DELETE own policy.
--   L-02  ai_schedule_logs  — SKIPPED: service_role ALL policy already
--                              exists (migration 20260319000010).
--
-- Pattern: DROP POLICY IF EXISTS + CREATE POLICY for idempotency.
-- No destructive table operations (only policy changes).
-- ============================================================================

BEGIN;

-- ─── H-03: exam_events — fix broken professor read policy ────────────────────
-- Original policy referenced course_enrollments (table does not exist).
-- exam_events has institution_id directly; use memberships for role check.
DROP POLICY IF EXISTS "exam_professor_read" ON exam_events;

CREATE POLICY "exam_professor_read" ON exam_events
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.user_id = auth.uid()
        AND m.institution_id = exam_events.institution_id
        AND m.role IN ('professor', 'admin', 'owner')
        AND m.is_active = true
    )
  );


-- ─── M-02: summary_blocks — scope student read by institution ────────────────
-- Old policy allowed any authenticated user to read any active block.
-- New policy requires user to have an active membership in the summary's
-- institution (via denormalized summaries.institution_id).
DROP POLICY IF EXISTS "Students read active summary_blocks" ON summary_blocks;

CREATE POLICY "Students read active summary_blocks" ON summary_blocks
  FOR SELECT USING (
    is_active = true
    AND EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = summary_blocks.summary_id
        AND s.deleted_at IS NULL
        AND s.institution_id IN (
          SELECT institution_id FROM memberships
          WHERE user_id = auth.uid() AND is_active = true
        )
    )
  );


-- ─── M-03: weekly_reports — add UPDATE and DELETE own policies ───────────────
-- Only SELECT and INSERT existed. Add UPDATE/DELETE for completeness.
DROP POLICY IF EXISTS "weekly_reports_update_own" ON weekly_reports;

CREATE POLICY "weekly_reports_update_own" ON weekly_reports
  FOR UPDATE USING (student_id = auth.uid())
  WITH CHECK (student_id = auth.uid());

DROP POLICY IF EXISTS "weekly_reports_delete_own" ON weekly_reports;

CREATE POLICY "weekly_reports_delete_own" ON weekly_reports
  FOR DELETE USING (student_id = auth.uid());


-- ─── M-04: finals_periods — add service_role ALL policy ──────────────────────
DROP POLICY IF EXISTS "finals_service_role_all" ON finals_periods;

CREATE POLICY "finals_service_role_all" ON finals_periods
  FOR ALL USING (auth.role() = 'service_role');


-- ─── M-05: exam_schedules — add service_role ALL policy ──────────────────────
DROP POLICY IF EXISTS "exam_schedules_service_role_all" ON exam_schedules;

CREATE POLICY "exam_schedules_service_role_all" ON exam_schedules
  FOR ALL USING (auth.role() = 'service_role');


-- ─── L-01: video_views — add DELETE own policy ───────────────────────────────
-- Column is user_id (verified from 20260224000002_video_views.sql).
DROP POLICY IF EXISTS "video_views_delete_own" ON video_views;

CREATE POLICY "video_views_delete_own" ON video_views
  FOR DELETE USING (user_id = auth.uid());


-- ─── L-02: ai_schedule_logs — no-op ─────────────────────────────────────────
-- Service role ALL policy already exists:
--   "Service role full access on ai_schedule_logs"
--   (created in 20260319000010_ai_schedule_logs.sql, lines 30-32)
-- No action needed.

COMMIT;

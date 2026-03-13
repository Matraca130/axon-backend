/**
 * routes/study/sessions.ts — Study sessions & plans
 *
 * Factory CRUD tables:
 *   study_sessions   — per-student study sessions
 *   study_plans      — per-student study plans
 *   study_plan_tasks — tasks within study plans
 *
 * DT-02 FIX: Added completion_date, weekly_hours, metadata to
 *   study_plans createFields/updateFields. Requires Migration 001
 *   (ALTER TABLE study_plans ADD COLUMN ...) before frontend sends data.
 *
 * PR1a CHANGES:
 *   study_plan_tasks — Added task_kind to createFields/updateFields.
 *     Requires migration 20260312_02_add_task_kind.sql.
 *
 * BUGFIX (Phase 5 regression):
 *   study_plan_tasks — Added original_method, scheduled_date,
 *     estimated_minutes to createFields. These were being sent by
 *     the frontend (useStudyPlans.createPlanFromWizard) but silently
 *     dropped by the CRUD factory because they weren't in createFields.
 *     Also added scheduled_date, estimated_minutes, original_method
 *     to updateFields (for rescheduleEngine batch updates).
 *
 * GAMIFICATION:
 *   Sprint 1 — xpHookForSessionComplete wired to study_sessions.
 *   PR #99  — xpHookForPlanTaskComplete wired to study_plan_tasks.
 *             Automatically checks plan completion and awards 100 XP bonus.
 *
 * FILE: supabase/functions/server/routes/study/sessions.ts
 * REPO: Matraca130/axon-backend
 */

import { Hono } from "npm:hono";
import { registerCrud } from "../../crud-factory.ts";
import { xpHookForSessionComplete, xpHookForPlanTaskComplete } from "../../xp-hooks.ts";

export const sessionRoutes = new Hono();

registerCrud(sessionRoutes, {
  table: "study_sessions",
  slug: "study-sessions",
  scopeToUser: "student_id",
  optionalFilters: ["course_id", "session_type"],
  hasCreatedBy: false,
  hasUpdatedAt: false,
  hasOrderIndex: false,
  requiredFields: ["session_type"],
  createFields: ["course_id", "session_type"],
  updateFields: ["completed_at", "total_reviews", "correct_reviews"],
  afterWrite: xpHookForSessionComplete, // Sprint 1: XP on session complete
});

registerCrud(sessionRoutes, {
  table: "study_plans",
  slug: "study-plans",
  scopeToUser: "student_id",
  optionalFilters: ["course_id", "status"],
  hasCreatedBy: false,
  hasUpdatedAt: true,
  hasOrderIndex: false,
  requiredFields: ["name"],
  createFields: ["course_id", "name", "status", "completion_date", "weekly_hours", "metadata"],
  updateFields: ["name", "status", "completion_date", "weekly_hours", "metadata"],
});

registerCrud(sessionRoutes, {
  table: "study_plan_tasks",
  slug: "study-plan-tasks",
  parentKey: "study_plan_id",
  hasCreatedBy: false,
  hasUpdatedAt: false,
  hasOrderIndex: true,
  requiredFields: ["item_type", "item_id"],
  createFields: [
    "item_type",
    "item_id",
    "status",
    "order_index",
    // Phase 5: wizard-generated plan data (was missing — BUGFIX)
    "original_method",
    "scheduled_date",
    "estimated_minutes",
    // PR1a: scheduling engine task kind
    "task_kind",
  ],
  updateFields: [
    "status",
    "order_index",
    "completed_at",
    // Phase 5: rescheduleEngine batch updates (was missing — BUGFIX)
    "scheduled_date",
    "estimated_minutes",
    "original_method",
    // PR1a: allow updating task kind (e.g. reclassification)
    "task_kind",
  ],
  afterWrite: xpHookForPlanTaskComplete, // PR #99: XP on task complete + plan complete check
});

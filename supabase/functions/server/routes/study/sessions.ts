/**
 * routes/study/sessions.ts — Study sessions & plans
 *
 * Factory CRUD tables:
 *   study_sessions   — per-student study sessions
 *   study_plans      — per-student study plans
 *   study_plan_tasks — tasks within study plans
 */

import { Hono } from "npm:hono";
import { registerCrud } from "../../crud-factory.ts";

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
  createFields: ["course_id", "name", "status"],
  updateFields: ["name", "status"],
});

registerCrud(sessionRoutes, {
  table: "study_plan_tasks",
  slug: "study-plan-tasks",
  parentKey: "study_plan_id",
  hasCreatedBy: false,
  hasUpdatedAt: false,
  hasOrderIndex: true,
  requiredFields: ["item_type", "item_id"],
  createFields: ["item_type", "item_id", "status", "order_index"],
  updateFields: ["status", "order_index", "completed_at"],
});

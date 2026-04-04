/**
 * routes/admin/finals-periods.ts — Finals periods CRUD
 *
 * GET    /admin/finals-periods?institution_id=xxx  → list
 * GET    /admin/finals-periods/:id                 → single
 * POST   /admin/finals-periods                     → create
 * PUT    /admin/finals-periods/:id                 → update
 * DELETE /admin/finals-periods/:id                 → delete
 *
 * Auth: admin/owner/professor role via registerCrud + parentKey scoping.
 * RLS enforces institution isolation at the DB level.
 */

import { Hono } from "npm:hono";
import { registerCrud } from "../../crud-factory.ts";

export const finalsPeriodsCrudRoutes = new Hono();

registerCrud(finalsPeriodsCrudRoutes, {
  table: "finals_periods",
  slug: "admin/finals-periods",
  parentKey: "institution_id",
  hasCreatedBy: true,
  requiredFields: ["finals_period_start", "finals_period_end"],
  createFields: [
    "institution_id",
    "course_id",
    "finals_period_start",
    "finals_period_end",
  ],
  updateFields: [
    "course_id",
    "finals_period_start",
    "finals_period_end",
  ],
});

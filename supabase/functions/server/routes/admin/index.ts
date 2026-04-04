/**
 * routes/admin/index.ts — Admin module combiner
 *
 * Sub-modules:
 *   finals-periods.ts — CRUD for finals_periods table (admin/owner/professor)
 */

import { Hono } from "npm:hono";
import { finalsPeriodsCrudRoutes } from "./finals-periods.ts";

const adminRoutes = new Hono();

adminRoutes.route("/", finalsPeriodsCrudRoutes);

export { adminRoutes };

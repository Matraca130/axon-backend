/**
 * routes/admin/index.ts — Admin module combiner
 *
 * Sub-modules:
 *   finals-periods.ts — GET/POST/PATCH/DELETE /admin/finals-periods
 */

import { Hono } from "npm:hono";
import { finalsPeriodsRoutes } from "./finals-periods.ts";

const adminRoutes = new Hono();

adminRoutes.route("/", finalsPeriodsRoutes);

export { adminRoutes };

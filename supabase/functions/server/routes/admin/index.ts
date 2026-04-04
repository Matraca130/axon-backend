/**
 * routes/admin/index.ts — Admin module combiner
 *
 * Mounts all admin sub-modules into a single Hono router.
 *
 * Sub-modules:
 *   finals-periods.ts — GET/POST/PATCH/DELETE /admin/finals-periods
 *
 * Phase 1 — Deploy endpoints
 */

import { Hono } from "npm:hono";
import { finalsPeriodsRoutes } from "./finals-periods.ts";

const adminRoutes = new Hono();

adminRoutes.route("/", finalsPeriodsRoutes);

export { adminRoutes };

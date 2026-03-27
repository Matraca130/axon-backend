/**
 * routes/calendar/index.ts — Calendar module combiner
 *
 * Mounts all calendar sub-modules into a single Hono router.
 *
 * Sub-modules:
 *   data.ts — GET /calendar/data (unified calendar endpoint)
 *
 * Session: S-0A (Calendar v2)
 */

import { Hono } from "npm:hono";
import { calendarDataRoutes } from "./data.ts";

const calendarRoutes = new Hono();

calendarRoutes.route("/", calendarDataRoutes);

export { calendarRoutes };

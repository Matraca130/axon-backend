/**
 * routes/calendar/index.ts — Calendar module combiner
 *
 * Mounts all calendar sub-modules into a single Hono router.
 *
 * Sub-modules:
 *   data.ts          — GET /calendar/data (unified calendar endpoint)
 *   fsrs-calendar.ts — GET /calendar/workload, GET /calendar/timeliness
 *
 * Session: S-0A (Calendar v2), Sprint 0 (FSRS/BKT integration)
 */

import { Hono } from "npm:hono";
import { calendarDataRoutes } from "./data.ts";
import { examEventRoutes } from "./exam-events.ts";
import { fsrsCalendarRoutes } from "./fsrs-calendar.ts";

const calendarRoutes = new Hono();

calendarRoutes.route("/", calendarDataRoutes);
calendarRoutes.route("/", examEventRoutes);
calendarRoutes.route("/", fsrsCalendarRoutes);

export { calendarRoutes };

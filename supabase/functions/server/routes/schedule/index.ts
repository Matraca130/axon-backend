/**
 * routes/schedule/index.ts — Schedule module combiner
 *
 * Sub-modules:
 *   momentum.ts       — GET /schedule/momentum
 *   exam-countdown.ts — GET /schedule/exam-prep/:examId
 */

import { Hono } from "npm:hono";
import { momentumRoutes } from "./momentum.ts";
import { examCountdownRoutes } from "./exam-countdown.ts";

const scheduleRoutes = new Hono();

scheduleRoutes.route("/", momentumRoutes);
scheduleRoutes.route("/", examCountdownRoutes);

export { scheduleRoutes };

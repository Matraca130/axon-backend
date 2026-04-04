/**
 * routes/schedule/index.ts — Schedule module combiner
 *
 * Mounts all schedule sub-modules into a single Hono router.
 *
 * Sub-modules:
 *   momentum.ts   — GET /schedule/momentum   (MomentumCard dashboard)
 *   exam-prep.ts  — GET /schedule/exam-prep/:examId (ExamPrepPanel)
 *
 * Phase 1 — Deploy endpoints
 */

import { Hono } from "npm:hono";
import { momentumRoutes } from "./momentum.ts";
import { examPrepRoutes } from "./exam-prep.ts";

const scheduleRoutes = new Hono();

scheduleRoutes.route("/", momentumRoutes);
scheduleRoutes.route("/", examPrepRoutes);

export { scheduleRoutes };

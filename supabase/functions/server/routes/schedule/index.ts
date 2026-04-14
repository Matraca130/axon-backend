/**
 * routes/schedule/index.ts — Schedule module combiner
 *
 * Sub-modules:
 *   momentum.ts        — GET /schedule/momentum        (MomentumCard dashboard)
 *   momentum-score.ts  — GET /schedule/momentum-score   (0-100 score for scheduling)
 *   exam-prep.ts       — GET /schedule/exam-prep/:examId (ExamPrepPanel dashboard)
 *   exam-countdown.ts  — GET /schedule/exam-countdown/:examId (FSRS review plan)
 */

import { Hono } from "npm:hono";
import { momentumRoutes } from "./momentum.ts";
import { momentumScoreRoutes } from "./momentum-score.ts";
import { examPrepRoutes } from "./exam-prep.ts";
import { examCountdownRoutes } from "./exam-countdown.ts";

const scheduleRoutes = new Hono();

scheduleRoutes.route("/", momentumRoutes);
scheduleRoutes.route("/", momentumScoreRoutes);
scheduleRoutes.route("/", examPrepRoutes);
scheduleRoutes.route("/", examCountdownRoutes);

export { scheduleRoutes };

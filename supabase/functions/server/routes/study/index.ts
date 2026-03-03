/**
 * routes/study/index.ts — Study module combiner
 *
 * Mounts all study sub-modules into a single Hono router.
 * Replaces the old monolithic routes-study.tsx (20KB+).
 *
 * Sub-modules:
 *   sessions.ts   — study-sessions, study-plans, study-plan-tasks (3 CRUDs)
 *   reviews.ts    — reviews + quiz-attempts (session ownership)
 *   progress.ts   — topic-progress, reading-states, daily-activities, student-stats
 *   spaced-rep.ts — fsrs-states, bkt-states (upserts)
 */

import { Hono } from "npm:hono";
import { sessionRoutes } from "./sessions.ts";
import { reviewRoutes } from "./reviews.ts";
import { progressRoutes } from "./progress.ts";
import { spacedRepRoutes } from "./spaced-rep.ts";

const studyRoutes = new Hono();

studyRoutes.route("/", sessionRoutes);
studyRoutes.route("/", reviewRoutes);
studyRoutes.route("/", progressRoutes);
studyRoutes.route("/", spacedRepRoutes);

export { studyRoutes };

/**
 * routes/plans/index.ts — Plans module combiner
 *
 * Mounts all plan sub-modules into a single Hono router.
 * Replaces the old monolithic routes-plans.tsx (13KB).
 *
 * Sub-modules:
 *   crud.ts           — 4 registerCrud calls (platform_plans, institution_plans, etc.)
 *   ai-generations.ts — AI generation audit log (LIST + POST)
 *   diagnostics.ts    — Summary diagnostics (LIST + POST)
 *   access.ts         — content-access + usage-today computed endpoints
 */

import { Hono } from "npm:hono";
import { planCrudRoutes } from "./crud.ts";
import { aiGenerationRoutes } from "./ai-generations.ts";
import { diagnosticRoutes } from "./diagnostics.ts";
import { accessRoutes } from "./access.ts";

const planRoutes = new Hono();

planRoutes.route("/", planCrudRoutes);
planRoutes.route("/", aiGenerationRoutes);
planRoutes.route("/", diagnosticRoutes);
planRoutes.route("/", accessRoutes);

export { planRoutes };

/**
 * routes/gamification/index.ts — Gamification module combiner
 *
 * Mounts all gamification sub-modules into a single Hono router.
 * Replaces the old monolithic routes-gamification.tsx (53KB).
 *
 * Sub-modules:
 *   profile.ts  — GET profile, xp-history, leaderboard (3 endpoints)
 *   badges.ts   — GET badges, POST check-badges, GET notifications (3 endpoints)
 *   streak.ts   — GET streak-status, POST daily-check-in, streak-freeze, streak-repair (4 endpoints)
 *   goals.ts    — PUT daily-goal, POST goals/complete, POST onboarding (3 endpoints)
 *
 * Total: 13 endpoints (same as before, zero breaking changes)
 *
 * Bug fixes applied during modularization:
 *   BUG-2: PUT /daily-goal uses getAdminClient() (goals.ts)
 *   BUG-3: GET /notifications uses created_at not earned_at (badges.ts)
 *   BUG-5: POST /daily-check-in skips XP on streak_broken (streak.ts)
 *   BUG-8: POST /streak-repair documents longest_streak restore as intentional (streak.ts)
 */

import { Hono } from "npm:hono";
import { profileRoutes } from "./profile.ts";
import { badgeRoutes } from "./badges.ts";
import { streakRoutes } from "./streak.ts";
import { goalRoutes } from "./goals.ts";

const gamificationRoutes = new Hono();

gamificationRoutes.route("/", profileRoutes);
gamificationRoutes.route("/", badgeRoutes);
gamificationRoutes.route("/", streakRoutes);
gamificationRoutes.route("/", goalRoutes);

export { gamificationRoutes };

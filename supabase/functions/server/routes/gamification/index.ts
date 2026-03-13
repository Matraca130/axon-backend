/**
 * routes/gamification/index.ts -- Gamification module combiner
 *
 * Sub-modules:
 *   profile.ts     -- GET profile, xp-history, leaderboard (3 endpoints)
 *   badges.ts      -- GET badges, POST check-badges, GET notifications (3 endpoints)
 *   streak.ts      -- GET streak-status, POST daily-check-in, streak-freeze, streak-repair (4 endpoints)
 *   goals.ts       -- PUT daily-goal, POST goals/complete, POST onboarding (3 endpoints)
 *   challenges.ts  -- GET challenges, GET history, POST check, POST claim, POST generate (5 endpoints)
 *
 * Total: 18 endpoints (Sprint 1 = 13, Sprint 2 = +5)
 */

import { Hono } from "npm:hono";
import { profileRoutes } from "./profile.ts";
import { badgeRoutes } from "./badges.ts";
import { streakRoutes } from "./streak.ts";
import { goalRoutes } from "./goals.ts";
import { challengeRoutes } from "./challenges.ts";

const gamificationRoutes = new Hono();

gamificationRoutes.route("/", profileRoutes);
gamificationRoutes.route("/", badgeRoutes);
gamificationRoutes.route("/", streakRoutes);
gamificationRoutes.route("/", goalRoutes);
gamificationRoutes.route("/", challengeRoutes);

export { gamificationRoutes };

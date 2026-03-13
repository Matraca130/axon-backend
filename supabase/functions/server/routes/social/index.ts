/**
 * routes/social/index.ts -- Social features module combiner
 *
 * Sub-modules:
 *   groups.ts -- Study groups (7 endpoints)
 *
 * Total: 7 social endpoints
 */

import { Hono } from "npm:hono";
import { groupRoutes } from "./groups.ts";

const socialRoutes = new Hono();

socialRoutes.route("/", groupRoutes);

export { socialRoutes };

/**
 * routes/settings/index.ts — Settings module combiner
 *
 * Mounts all settings sub-modules into a single Hono router.
 *
 * Sub-modules:
 *   algorithm-config.ts — Algorithm tuning (NeedScore weights + BKT priors)
 */

import { Hono } from "npm:hono";
import { algorithmConfigRoutes } from "./algorithm-config.ts";

const settingsRoutes = new Hono();

settingsRoutes.route("/", algorithmConfigRoutes);

export { settingsRoutes };

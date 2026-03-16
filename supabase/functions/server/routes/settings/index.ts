/**
 * routes/settings/index.ts — Settings module combiner
 *
 * Mounts all settings sub-modules into a single Hono router.
 *
 * Sub-modules:
 *   algorithm-config.ts — Algorithm tuning (NeedScore weights + BKT priors)
 *   messaging-admin.ts  — Admin settings for WhatsApp/Telegram integrations
 */

import { Hono } from "npm:hono";
import { PREFIX } from "../../db.ts";
import { algorithmConfigRoutes } from "./algorithm-config.ts";
import {
  getMessagingSettings,
  updateMessagingSettings,
  testMessagingConnection,
} from "./messaging-admin.ts";

const settingsRoutes = new Hono();

settingsRoutes.route("/", algorithmConfigRoutes);

// ─── Messaging Admin Settings ────────────────────────────
settingsRoutes.get(`${PREFIX}/settings/messaging/:channel`, getMessagingSettings);
settingsRoutes.put(`${PREFIX}/settings/messaging/:channel`, updateMessagingSettings);
settingsRoutes.post(`${PREFIX}/settings/messaging/:channel/test`, testMessagingConnection);

export { settingsRoutes };

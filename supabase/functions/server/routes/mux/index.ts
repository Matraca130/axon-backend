/**
 * routes/mux/index.ts — Mux module combiner
 *
 * Mounts all Mux sub-modules into a single Hono router.
 * Replaces the old monolithic routes-mux.ts (17KB).
 *
 * Sub-modules:
 *   helpers.ts   — Mux API client, signature verification, JWT builder
 *   api.ts       — create-upload, playback-token, video-stats, delete asset
 *   webhook.ts   — POST /webhooks/mux (HMAC verified, no auth)
 *   tracking.ts  — POST /mux/track-view (N-7 atomic upsert)
 */

import { Hono } from "npm:hono";
import { muxApiRoutes } from "./api.ts";
import { muxWebhookRoutes } from "./webhook.ts";
import { muxTrackingRoutes } from "./tracking.ts";

const muxRoutes = new Hono();

muxRoutes.route("/", muxApiRoutes);
muxRoutes.route("/", muxWebhookRoutes);
muxRoutes.route("/", muxTrackingRoutes);

export { muxRoutes };

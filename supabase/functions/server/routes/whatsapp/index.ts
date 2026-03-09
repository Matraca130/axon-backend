/**
 * routes/whatsapp/index.ts — WhatsApp module combiner
 *
 * Mounts all WhatsApp sub-modules into a single Hono router.
 *
 * Sub-modules:
 *   webhook.ts    — GET/POST /webhooks/whatsapp
 *   link.ts       — POST /whatsapp/link-code, /whatsapp/unlink
 *   async-queue   — POST /whatsapp/process-queue (C3 FIX)
 *
 * Feature flag: WHATSAPP_ENABLED env var.
 */

import { Hono } from "npm:hono";
import type { Context, Next } from "npm:hono";
import { PREFIX, err, ok, getAdminClient } from "../../db.ts";
import { handleVerification, handleIncoming } from "./webhook.ts";
import { generateLinkCode, unlinkPhone } from "./link.ts";
import { processPendingJobs } from "./async-queue.ts";

const whatsappRoutes = new Hono();

// ─── Feature Flag Middleware ────────────────────────────

const WHATSAPP_ENABLED = Deno.env.get("WHATSAPP_ENABLED") === "true";

async function featureFlagMiddleware(c: Context, next: Next) {
  if (!WHATSAPP_ENABLED) {
    return err(
      c,
      "WhatsApp integration is disabled. Set WHATSAPP_ENABLED=true to activate.",
      503,
    );
  }
  return next();
}

whatsappRoutes.use(`${PREFIX}/webhooks/whatsapp`, featureFlagMiddleware);
whatsappRoutes.use(`${PREFIX}/webhooks/whatsapp/*`, featureFlagMiddleware);
whatsappRoutes.use(`${PREFIX}/whatsapp/*`, featureFlagMiddleware);

// ─── Webhook Routes (no auth — verified by HMAC) ────────

whatsappRoutes.get(`${PREFIX}/webhooks/whatsapp`, handleVerification);
whatsappRoutes.post(`${PREFIX}/webhooks/whatsapp`, handleIncoming);

// ─── Link Routes (JWT auth required) ────────────────────

whatsappRoutes.post(`${PREFIX}/whatsapp/link-code`, generateLinkCode);
whatsappRoutes.post(`${PREFIX}/whatsapp/unlink`, unlinkPhone);

// ─── Queue Processing (C3 FIX) ──────────────────────────
// Called by pg_cron every 10 seconds:
//   SELECT cron.schedule('wa-queue-processor', '*/10 * * * * *',
//     $$SELECT net.http_post('https://<project>.supabase.co/functions/v1/server/whatsapp/process-queue',
//       '{}'::jsonb, '{"Authorization": "Bearer <service_role_key>"}'::jsonb)$$);
// Also called fire-and-forget from handler.ts after each enqueue.

whatsappRoutes.post(`${PREFIX}/whatsapp/process-queue`, async (c: Context) => {
  // No JWT auth needed — this endpoint is internal (called by pg_cron/service_role)
  // The feature flag middleware already gates access.
  try {
    const processed = await processPendingJobs(5);
    return ok(c, { processed });
  } catch (e) {
    console.error(`[WA-Queue] Process queue failed: ${(e as Error).message}`);
    return err(c, "Queue processing failed", 500);
  }
});

export { whatsappRoutes };

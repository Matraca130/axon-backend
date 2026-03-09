/**
 * routes/whatsapp/index.ts — WhatsApp module combiner
 *
 * Sub-modules:
 *   webhook.ts    — GET/POST /webhooks/whatsapp
 *   link.ts       — POST /whatsapp/link-code, /whatsapp/unlink
 *   async-queue   — POST /whatsapp/process-queue (C3 FIX)
 *
 * Feature flag: WHATSAPP_ENABLED env var.
 *
 * N1 FIX: process-queue validates service_role_key via timing-safe comparison.
 * N7 FIX: Removed unused getAdminClient import.
 */

import { Hono } from "npm:hono";
import type { Context, Next } from "npm:hono";
import { PREFIX, err, ok } from "../../db.ts";
import { timingSafeEqual } from "../../timing-safe.ts";
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

// ─── Queue Processing (C3 + N1 FIX) ────────────────────
// Called by pg_cron every minute:
//   SELECT cron.schedule('wa-job-processor', '* * * * *',
//     $$SELECT net.http_post(...)$$);
// Also called fire-and-forget from handler.ts after each enqueue.
//
// N1 FIX: Validates service_role_key to prevent public abuse.
// pg_cron sends Authorization: Bearer <service_role_key>.
// handler.ts fire-and-forget calls this internally (same isolate,
// imports processNextJob directly, doesn't go through HTTP).

whatsappRoutes.post(`${PREFIX}/whatsapp/process-queue`, async (c: Context) => {
  // N1 FIX: Validate caller is service_role (pg_cron) or internal
  const authHeader = c.req.header("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  if (!token || !serviceRoleKey || !timingSafeEqual(token, serviceRoleKey)) {
    console.warn("[WA-Queue] Unauthorized process-queue attempt");
    return err(c, "Unauthorized", 401);
  }

  try {
    const processed = await processPendingJobs(5);
    return ok(c, { processed });
  } catch (e) {
    console.error(`[WA-Queue] Process queue failed: ${(e as Error).message}`);
    return err(c, "Queue processing failed", 500);
  }
});

export { whatsappRoutes };

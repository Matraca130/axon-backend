/**
 * routes/whatsapp/index.ts — WhatsApp module combiner
 *
 * Mounts all WhatsApp sub-modules into a single Hono router.
 * Follows the same pattern as routes/ai/index.ts and routes/mux/index.ts.
 *
 * Sub-modules:
 *   webhook.ts    — GET  /webhooks/whatsapp (Meta verification challenge)
 *                   POST /webhooks/whatsapp (incoming messages, HMAC verified)
 *   link.ts       — POST /whatsapp/link-code  (generate 6-digit code, JWT required)
 *                   POST /whatsapp/unlink     (deactivate link, JWT required)
 *
 * Feature flag: WHATSAPP_ENABLED env var.
 *   - Set to "true" to enable all WhatsApp endpoints.
 *   - Any other value (or unset) → all endpoints return 503.
 *   - This allows safe deployment: merge code to main with flag off,
 *     enable in staging first, then production.
 *
 * How to activate:
 *   supabase secrets set WHATSAPP_ENABLED=true
 *   supabase secrets set WHATSAPP_VERIFY_TOKEN=<random-string>
 *   supabase secrets set WHATSAPP_APP_SECRET=<from-meta-dashboard>
 *   supabase secrets set WHATSAPP_PHONE_NUMBER_ID=<your-business-phone-id>
 *   supabase secrets set WHATSAPP_ACCESS_TOKEN=<permanent-or-system-user-token>
 */

import { Hono } from "npm:hono";
import type { Context, Next } from "npm:hono";
import { PREFIX, err } from "../../db.ts";
import { handleVerification, handleIncoming } from "./webhook.ts";
import { generateLinkCode, unlinkPhone } from "./link.ts";

const whatsappRoutes = new Hono();

// ─── Feature Flag Middleware ────────────────────────────────

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

// Apply feature flag to all WhatsApp routes
whatsappRoutes.use(`${PREFIX}/webhooks/whatsapp`, featureFlagMiddleware);
whatsappRoutes.use(`${PREFIX}/webhooks/whatsapp/*`, featureFlagMiddleware);
whatsappRoutes.use(`${PREFIX}/whatsapp/*`, featureFlagMiddleware);

// ─── Webhook Routes (no auth — verified by HMAC) ─────────────

whatsappRoutes.get(`${PREFIX}/webhooks/whatsapp`, handleVerification);
whatsappRoutes.post(`${PREFIX}/webhooks/whatsapp`, handleIncoming);

// ─── Link Routes (JWT auth required) ───────────────────────

whatsappRoutes.post(`${PREFIX}/whatsapp/link-code`, generateLinkCode);
whatsappRoutes.post(`${PREFIX}/whatsapp/unlink`, unlinkPhone);

export { whatsappRoutes };

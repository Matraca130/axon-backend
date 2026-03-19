/**
 * routes/telegram/index.ts — Telegram module combiner
 *
 * Sub-modules:
 *   webhook.ts    — POST /webhooks/telegram
 *   link.ts       — POST /telegram/link-code, /telegram/unlink, GET /telegram/link-status
 *
 * Feature flag: TELEGRAM_ENABLED env var.
 */

import { Hono } from "npm:hono";
import type { Context, Next } from "npm:hono";
import { PREFIX, err, ok } from "../../db.ts";
import { timingSafeEqual } from "../../timing-safe.ts";
import { safeErr } from "../../lib/safe-error.ts";
import { handleIncomingUpdate } from "./webhook.ts";
import { generateLinkCode, getLinkStatus, unlinkTelegram } from "./link.ts";
import { setWebhook, deleteWebhook, getMe } from "./tg-client.ts";
import { processPendingJobs } from "./async-queue.ts";

const telegramRoutes = new Hono();

// ─── Feature Flag Middleware ─────────────────────────────

const TELEGRAM_ENABLED = Deno.env.get("TELEGRAM_ENABLED") === "true";

async function featureFlagMiddleware(c: Context, next: Next) {
  if (!TELEGRAM_ENABLED) {
    return err(
      c,
      "Telegram integration is disabled. Set TELEGRAM_ENABLED=true to activate.",
      503,
    );
  }
  return next();
}

telegramRoutes.use(`${PREFIX}/webhooks/telegram`, featureFlagMiddleware);
telegramRoutes.use(`${PREFIX}/webhooks/telegram/*`, featureFlagMiddleware);
telegramRoutes.use(`${PREFIX}/telegram/*`, featureFlagMiddleware);

// ─── Webhook Route (no JWT auth — verified by secret token) ──

telegramRoutes.post(`${PREFIX}/webhooks/telegram`, handleIncomingUpdate);

// ─── Link Routes (JWT auth required) ────────────────────

telegramRoutes.post(`${PREFIX}/telegram/link-code`, generateLinkCode);
telegramRoutes.post(`${PREFIX}/telegram/unlink`, unlinkTelegram);
telegramRoutes.get(`${PREFIX}/telegram/link-status`, getLinkStatus);

// ─── Admin: Webhook Setup ────────────────────────────────
// POST /telegram/setup-webhook — Sets the Telegram webhook URL
// Requires service_role_key auth (admin only)

telegramRoutes.post(`${PREFIX}/telegram/setup-webhook`, async (c: Context) => {
  const authHeader = c.req.header("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  if (!token || !serviceRoleKey || !timingSafeEqual(token, serviceRoleKey)) {
    return err(c, "Unauthorized", 401);
  }

  try {
    const body = await c.req.json();
    const webhookUrl = body.webhook_url as string;

    if (!webhookUrl) {
      return err(c, "webhook_url is required", 400);
    }

    const success = await setWebhook(webhookUrl);
    if (success) {
      const botInfo = await getMe();
      return ok(c, { success: true, webhook_url: webhookUrl, bot: botInfo });
    }
    return err(c, "Failed to set webhook", 500);
  } catch (e) {
    return safeErr(c, "Telegram setup", e instanceof Error ? e : null);
  }
});

// POST /telegram/delete-webhook — Removes the webhook
telegramRoutes.post(`${PREFIX}/telegram/delete-webhook`, async (c: Context) => {
  const authHeader = c.req.header("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  if (!token || !serviceRoleKey || !timingSafeEqual(token, serviceRoleKey)) {
    return err(c, "Unauthorized", 401);
  }

  const success = await deleteWebhook();
  return ok(c, { success });
});

// ─── Queue Processing ────────────────────────────────────
// Called by pg_cron every minute. Also called fire-and-forget from handler.ts.
// Validates service_role_key to prevent public abuse.

telegramRoutes.post(`${PREFIX}/telegram/process-queue`, async (c: Context) => {
  const authHeader = c.req.header("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  if (!token || !serviceRoleKey || !timingSafeEqual(token, serviceRoleKey)) {
    console.warn("[TG-Queue] Unauthorized process-queue attempt");
    return err(c, "Unauthorized", 401);
  }

  try {
    const processed = await processPendingJobs(5);
    return ok(c, { processed });
  } catch (e) {
    console.error(`[TG-Queue] Process queue failed: ${(e as Error).message}`);
    return err(c, "Queue processing failed", 500);
  }
});

export { telegramRoutes };

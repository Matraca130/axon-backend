/**
 * routes/billing/webhook.ts — Stripe webhook handler for Axon v4.4
 *
 * Extracted from routes-billing.ts (PR #103).
 *
 * POST /webhooks/stripe
 *   Handles: checkout.session.completed, customer.subscription.updated,
 *   customer.subscription.deleted, invoice.payment_failed.
 *
 * Security:
 *   N-10 FIX: Timing-safe Stripe signature verification.
 *   O-7 FIX: Webhook idempotency via processed_webhook_events table.
 *   W7-BILL01 FIX: DB errors checked and 500 returned for Stripe retry.
 *   W7-BILL02 FIX: Metadata UUIDs validated before DB operations.
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { getAdminClient, ok, err, PREFIX } from "../../db.ts";
import { safeErr } from "../../lib/safe-error.ts";
import { isUuid } from "../../validate.ts";
import { timingSafeEqual } from "../../timing-safe.ts";

export const webhookRoutes = new Hono();

// ─── POST /webhooks/stripe ───────────────────────────────────────

webhookRoutes.post(`${PREFIX}/webhooks/stripe`, async (c: Context) => {
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!webhookSecret) return err(c, "STRIPE_WEBHOOK_SECRET not configured", 500);

  const signature = c.req.header("stripe-signature");
  if (!signature) return err(c, "Missing stripe-signature header", 400);

  const rawBody = await c.req.text();

  const verified = await verifyStripeSignature(rawBody, signature, webhookSecret);
  if (!verified) return err(c, "Invalid webhook signature", 400);

  const event = JSON.parse(rawBody);
  const admin = getAdminClient();

  // O-7 FIX: Idempotency check
  const eventId: string | undefined = event.id;
  if (eventId) {
    try {
      const { data: existing } = await admin
        .from("processed_webhook_events")
        .select("id")
        .eq("event_id", eventId)
        .eq("source", "stripe")
        .maybeSingle();

      if (existing) {
        console.log(`[Stripe Webhook] Duplicate event ${eventId}, skipping`);
        return ok(c, { received: true, deduplicated: true });
      }
    } catch {
      console.warn("[Stripe Webhook] processed_webhook_events table not found, skipping idempotency");
    }
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const metadata = session.metadata ?? {};
        const institutionId = metadata.institution_id;
        const planId = metadata.plan_id;
        const userId = metadata.user_id;

        if (!institutionId || !planId || !userId) {
          console.error("[Stripe Webhook] Missing metadata in checkout.session.completed");
          break;
        }

        // W7-BILL02 FIX: Validate metadata UUIDs
        if (!isUuid(institutionId) || !isUuid(planId) || !isUuid(userId)) {
          console.error(
            `[Stripe Webhook] Invalid UUID in metadata: institution_id=${institutionId}, plan_id=${planId}, user_id=${userId}`,
          );
          break;
        }

        // W7-BILL01 FIX: Check INSERT error
        const { error: insertErr } = await admin.from("institution_subscriptions").insert({
          institution_id: institutionId,
          plan_id: planId,
          user_id: userId,
          stripe_subscription_id: session.subscription,
          stripe_customer_id: session.customer,
          status: session.status === "complete" ? "active" : "trialing",
          current_period_start: new Date().toISOString(),
        });

        if (insertErr) {
          console.error(`[Stripe Webhook] Insert subscription failed: ${insertErr.message}`);
          throw new Error(`Insert subscription failed: ${insertErr.message}`);
        }

        // W7-BILL01 FIX: Check UPDATE error (non-fatal)
        const { error: updateErr } = await admin.from("memberships")
          .update({ institution_plan_id: planId, updated_at: new Date().toISOString() })
          .eq("user_id", userId).eq("institution_id", institutionId);

        if (updateErr) {
          console.error(
            `[Stripe Webhook] Update membership plan_id failed (non-fatal): ${updateErr.message}`,
          );
        }
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object;
        const { error: updateErr } = await admin.from("institution_subscriptions").update({
          status: sub.status,
          current_period_start: sub.current_period_start ? new Date(sub.current_period_start * 1000).toISOString() : null,
          current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
          cancel_at_period_end: sub.cancel_at_period_end ?? false,
          trial_start: sub.trial_start ? new Date(sub.trial_start * 1000).toISOString() : null,
          trial_end: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
          updated_at: new Date().toISOString(),
        }).eq("stripe_subscription_id", sub.id);

        if (updateErr) {
          console.error(`[Stripe Webhook] Update subscription failed: ${updateErr.message}`);
          throw new Error(`Update subscription failed: ${updateErr.message}`);
        }
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const { error: deleteErr } = await admin.from("institution_subscriptions").update({
          status: "canceled",
          canceled_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("stripe_subscription_id", sub.id);

        if (deleteErr) {
          console.error(`[Stripe Webhook] Cancel subscription failed: ${deleteErr.message}`);
          throw new Error(`Cancel subscription failed: ${deleteErr.message}`);
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object;
        if (invoice.subscription) {
          const { error: failErr } = await admin.from("institution_subscriptions").update({
            status: "past_due",
            updated_at: new Date().toISOString(),
          }).eq("stripe_subscription_id", invoice.subscription);

          if (failErr) {
            console.error(`[Stripe Webhook] Mark past_due failed: ${failErr.message}`);
            throw new Error(`Mark past_due failed: ${failErr.message}`);
          }
        }
        break;
      }

      default:
        console.log(`[Stripe Webhook] Unhandled event type: ${event.type}`);
    }

    // O-7: Mark event as processed (best-effort)
    if (eventId) {
      try {
        await admin.from("processed_webhook_events").insert({
          event_id: eventId,
          event_type: event.type,
          source: "stripe",
        });
      } catch {
        // Table might not exist yet
      }
    }

    return ok(c, { received: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error(`[Stripe Webhook] Error processing ${event.type}: ${msg}`);
    return safeErr(c, "Webhook processing", e instanceof Error ? e : null);
  }
});

// ─── Stripe Signature Verification ───────────────────────────────

/**
 * Verify Stripe webhook signature using HMAC-SHA256.
 * N-10 FIX: Uses timingSafeEqual() for constant-time comparison.
 */
async function verifyStripeSignature(
  payload: string,
  header: string,
  secret: string,
): Promise<boolean> {
  try {
    const parts = header.split(",").reduce(
      (acc, part) => {
        const [key, value] = part.split("=");
        if (key === "t") acc.timestamp = value;
        if (key === "v1") acc.signatures.push(value);
        return acc;
      },
      { timestamp: "", signatures: [] as string[] },
    );

    if (!parts.timestamp || parts.signatures.length === 0) return false;

    // Check timestamp tolerance (5 minutes)
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - parseInt(parts.timestamp)) > 300) return false;

    // Compute expected signature
    const signedPayload = `${parts.timestamp}.${payload}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
    const expected = Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // N-10 FIX: Constant-time comparison
    return parts.signatures.some((s) => timingSafeEqual(s, expected));
  } catch {
    return false;
  }
}

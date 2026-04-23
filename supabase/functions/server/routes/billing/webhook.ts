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

// Minimal shape we rely on; downstream handlers still validate metadata fields.
// deno-lint-ignore no-explicit-any
type StripeEventPayload = { id?: string; type: string; data: { object: any } };

function isStripeEventPayload(x: unknown): x is StripeEventPayload {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if (typeof o.type !== "string") return false;
  if (!o.data || typeof o.data !== "object") return false;
  const data = o.data as Record<string, unknown>;
  if (data.object === undefined || data.object === null) return false;
  if (o.id !== undefined && typeof o.id !== "string") return false;
  return true;
}

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

  let event: StripeEventPayload;
  try {
    const parsed = JSON.parse(rawBody);
    if (!isStripeEventPayload(parsed)) {
      console.error(
        `[Stripe Webhook] Payload missing required shape (id/type/data.object) — body length ${rawBody.length}`,
      );
      return err(c, "Invalid webhook payload shape", 400);
    }
    event = parsed;
  } catch (e) {
    console.error(
      `[Stripe Webhook] Invalid JSON payload (body length ${rawBody.length}): ${(e as Error).message}`,
    );
    return err(c, "Invalid JSON payload", 400);
  }
  const admin = getAdminClient();

  // Idempotency via INSERT-first to avoid TOCTOU race (#267). Two
  // concurrent Stripe delivery attempts could both pass a SELECT-then-
  // INSERT existence check and double-process the event. The unique
  // index idx_pwe_event_id_source on (event_id, source) serialises us.
  // If the insert hits 23505 unique_violation, it's a duplicate delivery;
  // short-circuit before any business logic.
  //
  // Failure semantics:
  //   - 23505 (duplicate)     → 200 deduplicated, safe to skip.
  //   - any other DB error    → 500 so Stripe retries; we won't run business
  //                             logic without an idempotency guarantee.
  //   - business-logic throws → compensate by DELETE'ing the dedup row so the
  //                             next Stripe retry gets a fresh attempt rather
  //                             than being silently acked as already-processed
  //                             (which would drop a paid checkout on the floor).
  const eventId: string | undefined = event.id;
  if (!eventId) {
    // Stripe always populates event.id on a valid signed delivery; a missing
    // id on an already-verified signature indicates a malformed payload. Refuse
    // to proceed without idempotency rather than silently bypassing it.
    console.error(
      `[Stripe Webhook] Missing event.id on verified-signature payload (type=${event.type}) — rejecting`,
    );
    return err(c, "Missing event.id on verified payload", 400);
  }

  const { error: dedupeErr } = await admin
    .from("processed_webhook_events")
    .insert({
      event_id: eventId,
      event_type: event.type,
      source: "stripe",
    });

  if (dedupeErr) {
    const code = (dedupeErr as { code?: string }).code;
    if (code === "23505") {
      console.warn(`[Stripe Webhook] Duplicate event ${eventId}, skipping`);
      return ok(c, { received: true, deduplicated: true });
    }
    // Any other DB error means we have no idempotency guarantee. Fail so
    // Stripe retries — do NOT proceed to business logic without protection.
    console.error(
      `[Stripe Webhook] processed_webhook_events insert failed (code=${code ?? "unknown"}): ${dedupeErr.message} — returning 500 for Stripe retry`,
    );
    return err(c, "Idempotency check unavailable", 500);
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
        console.warn(`[Stripe Webhook] Unhandled event type: ${event.type}`);
    }

    // Event is already marked as processed by the INSERT-first idempotency
    // check above — no trailing INSERT needed.

    return ok(c, { received: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error(`[Stripe Webhook] Error processing ${event.type}: ${msg}`);

    // Compensate the dedup row so Stripe's retry gets a fresh attempt.
    // Without this, the row from the INSERT-first guard above would make the
    // next delivery hit 23505 → 200 deduplicated, and the event would be
    // silently lost (subscription never created, past_due never flagged).
    // If this compensating delete itself fails, flag loudly — the retry will
    // be dedup-acked and the event will need manual operator recovery.
    const { error: compensateErr } = await admin
      .from("processed_webhook_events")
      .delete()
      .eq("event_id", eventId)
      .eq("source", "stripe");
    if (compensateErr) {
      console.error(
        `[Stripe Webhook] CRITICAL: compensating delete failed for event ${eventId} (type=${event.type}): ${compensateErr.message} — Stripe retry will be deduplicated and the event will be lost until manually cleared`,
      );
    }

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

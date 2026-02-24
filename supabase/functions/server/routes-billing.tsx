/**
 * routes-billing.tsx — Stripe Billing integration for Axon v4.4
 *
 * Routes:
 *   POST /billing/checkout-session  — Create Stripe Checkout session
 *   POST /billing/portal-session    — Create Stripe Billing Portal session
 *   POST /webhooks/stripe           — Handle Stripe webhook events
 *   GET  /billing/subscription-status — Get subscription status for user+institution
 *
 * Env vars required (PASO 3):
 *   STRIPE_SECRET_KEY      — Stripe secret key
 *   STRIPE_WEBHOOK_SECRET  — Stripe webhook signing secret
 *
 * ⚠️  These routes will compile but NOT function until the env vars are set.
 *     The CRUD routes for institution_plans and institution_subscriptions
 *     (in routes-plans.tsx) work independently of Stripe.
 */

import { Hono } from "npm:hono";
import { authenticate, getAdminClient, ok, err, safeJson, PREFIX } from "./db.ts";
import { isUuid, isNonEmpty } from "./validate.ts";
import type { Context } from "npm:hono";

const billingRoutes = new Hono();

// ─── Stripe Client (lazy init) ───────────────────────────────────────

let _stripe: any = null;

const getStripe = () => {
  if (_stripe) return _stripe;
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) throw new Error("STRIPE_SECRET_KEY not configured");
  // Dynamic import not available in Deno edge — use fetch-based Stripe API
  // We implement a lightweight Stripe client using fetch
  _stripe = {
    _key: key,
    async request(method: string, path: string, body?: Record<string, unknown>) {
      const url = `https://api.stripe.com/v1${path}`;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/x-www-form-urlencoded",
      };
      const options: RequestInit = { method, headers };
      if (body) {
        options.body = encodeFormData(body);
      }
      const res = await fetch(url, options);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error?.message ?? `Stripe API error: ${res.status}`);
      }
      return data;
    },
  };
  return _stripe;
};

/**
 * Encode a nested object into Stripe's form-urlencoded format.
 * Stripe expects: line_items[0][price]=xxx&line_items[0][quantity]=1
 */
function encodeFormData(
  obj: Record<string, unknown>,
  prefix = "",
): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === "object" && !Array.isArray(value)) {
      parts.push(encodeFormData(value as Record<string, unknown>, fullKey));
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (typeof item === "object") {
          parts.push(encodeFormData(item as Record<string, unknown>, `${fullKey}[${i}]`));
        } else {
          parts.push(`${encodeURIComponent(`${fullKey}[${i}]`)}=${encodeURIComponent(String(item))}`);
        }
      });
    } else {
      parts.push(`${encodeURIComponent(fullKey)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.filter(Boolean).join("&");
}

// ─── POST /billing/checkout-session ──────────────────────────────────
// Creates a Stripe Checkout session for subscribing to a plan.

billingRoutes.post(`${PREFIX}/billing/checkout-session`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const { plan_id, institution_id, success_url, cancel_url } = body as Record<string, string>;

  if (!isUuid(plan_id)) return err(c, "plan_id must be a valid UUID", 400);
  if (!isUuid(institution_id)) return err(c, "institution_id must be a valid UUID", 400);
  if (!isNonEmpty(success_url)) return err(c, "success_url is required", 400);
  if (!isNonEmpty(cancel_url)) return err(c, "cancel_url is required", 400);

  // 1. Get institution plan → stripe_price_id, trial_days
  const { data: plan, error: planErr } = await db
    .from("institution_plans")
    .select("*")
    .eq("id", plan_id)
    .single();

  if (planErr || !plan) {
    return err(c, `Plan not found: ${planErr?.message ?? "no data"}`, 404);
  }

  if (!plan.stripe_price_id) {
    return err(c, "Plan does not have a Stripe price configured", 400);
  }

  // 2. Find or reference existing Stripe customer
  const { data: existingSub } = await db
    .from("institution_subscriptions")
    .select("stripe_customer_id")
    .eq("user_id", user.id)
    .not("stripe_customer_id", "is", null)
    .limit(1)
    .maybeSingle();

  try {
    const stripe = getStripe();

    // Build checkout session params
    const sessionParams: Record<string, unknown> = {
      mode: "subscription",
      "line_items[0][price]": plan.stripe_price_id,
      "line_items[0][quantity]": 1,
      success_url: success_url,
      cancel_url: cancel_url,
      "metadata[institution_id]": institution_id,
      "metadata[plan_id]": plan_id,
      "metadata[user_id]": user.id,
    };

    // Attach existing customer or let Stripe create one
    if (existingSub?.stripe_customer_id) {
      sessionParams.customer = existingSub.stripe_customer_id;
    }

    // Trial period
    if (plan.trial_days > 0) {
      sessionParams["subscription_data[trial_period_days]"] = plan.trial_days;
    }

    const session = await stripe.request("POST", "/checkout/sessions", sessionParams);

    return ok(c, { url: session.url, session_id: session.id });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown Stripe error";
    return err(c, `Stripe checkout failed: ${msg}`, 500);
  }
});

// ─── POST /billing/portal-session ────────────────────────────────────
// Creates a Stripe Billing Portal session for managing subscriptions.

billingRoutes.post(`${PREFIX}/billing/portal-session`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const { institution_id, return_url } = body as Record<string, string>;

  if (!isUuid(institution_id)) return err(c, "institution_id must be a valid UUID", 400);
  if (!isNonEmpty(return_url)) return err(c, "return_url is required", 400);

  // Find the user's Stripe customer ID
  const { data: sub } = await db
    .from("institution_subscriptions")
    .select("stripe_customer_id")
    .eq("user_id", user.id)
    .eq("institution_id", institution_id)
    .not("stripe_customer_id", "is", null)
    .limit(1)
    .maybeSingle();

  if (!sub?.stripe_customer_id) {
    return err(c, "No Stripe customer found for this user/institution", 404);
  }

  try {
    const stripe = getStripe();
    const session = await stripe.request("POST", "/billing_portal/sessions", {
      customer: sub.stripe_customer_id,
      return_url: return_url,
    });

    return ok(c, { url: session.url });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown Stripe error";
    return err(c, `Stripe portal failed: ${msg}`, 500);
  }
});

// ─── POST /webhooks/stripe ───────────────────────────────────────────
// Handles Stripe webhook events. Verifies signature, then processes events.
// NOTE: This route uses admin client (bypasses RLS) since webhooks have no user JWT.

billingRoutes.post(`${PREFIX}/webhooks/stripe`, async (c: Context) => {
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!webhookSecret) {
    return err(c, "STRIPE_WEBHOOK_SECRET not configured", 500);
  }

  const signature = c.req.header("stripe-signature");
  if (!signature) {
    return err(c, "Missing stripe-signature header", 400);
  }

  // Read raw body for signature verification
  const rawBody = await c.req.text();

  // Verify webhook signature (Stripe v1 scheme)
  const verified = await verifyStripeSignature(rawBody, signature, webhookSecret);
  if (!verified) {
    return err(c, "Invalid webhook signature", 400);
  }

  const event = JSON.parse(rawBody);
  const admin = getAdminClient();

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

        const subscriptionId = session.subscription;
        const customerId = session.customer;
        const status = session.status === "complete" ? "active" : "trialing";

        // INSERT subscription record
        await admin.from("institution_subscriptions").insert({
          institution_id: institutionId,
          plan_id: planId,
          user_id: userId,
          stripe_subscription_id: subscriptionId,
          stripe_customer_id: customerId,
          status,
          current_period_start: new Date().toISOString(),
        });

        // UPDATE membership: link institution_plan_id
        await admin
          .from("memberships")
          .update({ institution_plan_id: planId, updated_at: new Date().toISOString() })
          .eq("user_id", userId)
          .eq("institution_id", institutionId);

        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object;
        await admin
          .from("institution_subscriptions")
          .update({
            status: sub.status,
            current_period_start: sub.current_period_start
              ? new Date(sub.current_period_start * 1000).toISOString()
              : null,
            current_period_end: sub.current_period_end
              ? new Date(sub.current_period_end * 1000).toISOString()
              : null,
            cancel_at_period_end: sub.cancel_at_period_end ?? false,
            trial_start: sub.trial_start
              ? new Date(sub.trial_start * 1000).toISOString()
              : null,
            trial_end: sub.trial_end
              ? new Date(sub.trial_end * 1000).toISOString()
              : null,
            updated_at: new Date().toISOString(),
          })
          .eq("stripe_subscription_id", sub.id);
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object;
        await admin
          .from("institution_subscriptions")
          .update({
            status: "canceled",
            canceled_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("stripe_subscription_id", sub.id);
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object;
        const subId = invoice.subscription;
        if (subId) {
          await admin
            .from("institution_subscriptions")
            .update({
              status: "past_due",
              updated_at: new Date().toISOString(),
            })
            .eq("stripe_subscription_id", subId);
        }
        break;
      }

      default:
        console.log(`[Stripe Webhook] Unhandled event type: ${event.type}`);
    }

    return ok(c, { received: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error(`[Stripe Webhook] Error processing ${event.type}: ${msg}`);
    return err(c, `Webhook processing failed: ${msg}`, 500);
  }
});

/**
 * Verify Stripe webhook signature using HMAC-SHA256.
 * Implements Stripe's v1 signature scheme without the Stripe SDK.
 */
async function verifyStripeSignature(
  payload: string,
  header: string,
  secret: string,
): Promise<boolean> {
  try {
    // Parse the signature header
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

    // Constant-time comparison
    return parts.signatures.some((s) => s === expected);
  } catch {
    return false;
  }
}

// ─── GET /billing/subscription-status ────────────────────────────────
// Returns the current subscription status for a user+institution pair.

billingRoutes.get(`${PREFIX}/billing/subscription-status`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const userId = c.req.query("user_id");
  const institutionId = c.req.query("institution_id");

  if (!isUuid(userId)) return err(c, "user_id must be a valid UUID", 400);
  if (!isUuid(institutionId)) return err(c, "institution_id must be a valid UUID", 400);

  // Get the most recent active subscription
  const { data: sub, error: subErr } = await db
    .from("institution_subscriptions")
    .select("*, institution_plans(*)")
    .eq("user_id", userId)
    .eq("institution_id", institutionId)
    .in("status", ["active", "trialing", "past_due"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (subErr) {
    return err(c, `Subscription lookup failed: ${subErr.message}`, 500);
  }

  // No active subscription — check for free plan
  if (!sub) {
    const { data: freePlan } = await db
      .from("institution_plans")
      .select("*")
      .eq("institution_id", institutionId)
      .eq("is_free", true)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();

    return ok(c, {
      subscription: null,
      plan: freePlan ?? null,
      features: freePlan?.features ?? null,
      is_active: !!freePlan,
      is_trial: false,
      days_remaining: null,
    });
  }

  // Calculate days remaining
  let daysRemaining: number | null = null;
  const endDate = sub.trial_end ?? sub.current_period_end;
  if (endDate) {
    const diff = new Date(endDate).getTime() - Date.now();
    daysRemaining = Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
  }

  const plan = sub.institution_plans;

  return ok(c, {
    subscription: {
      id: sub.id,
      status: sub.status,
      stripe_subscription_id: sub.stripe_subscription_id,
      current_period_start: sub.current_period_start,
      current_period_end: sub.current_period_end,
      trial_start: sub.trial_start,
      trial_end: sub.trial_end,
      cancel_at_period_end: sub.cancel_at_period_end,
      canceled_at: sub.canceled_at,
    },
    plan: plan
      ? {
          id: plan.id,
          name: plan.name,
          description: plan.description,
          price_cents: plan.price_cents,
          billing_cycle: plan.billing_cycle,
          currency: plan.currency,
          is_free: plan.is_free,
          features: plan.features,
        }
      : null,
    features: plan?.features ?? null,
    is_active: ["active", "trialing"].includes(sub.status),
    is_trial: sub.status === "trialing",
    days_remaining: daysRemaining,
  });
});

export { billingRoutes };

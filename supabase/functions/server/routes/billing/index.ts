/**
 * routes/billing/index.ts — Billing module combiner
 *
 * Mounts all billing sub-modules into a single Hono router.
 * Replaces the old monolithic routes-billing.ts (16.7KB).
 *
 * Sub-modules:
 *   stripe-client.ts — Stripe API client (no routes)
 *   webhook.ts       — POST /webhooks/stripe
 *   index.ts (this)  — POST /billing/checkout-session
 *                       POST /billing/portal-session
 *                       GET  /billing/subscription-status
 *
 * PR #103: Modularized from routes-billing.ts.
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, safeJson, PREFIX } from "../../db.ts";
import { safeErr } from "../../lib/safe-error.ts";
import { isUuid, isNonEmpty } from "../../validate.ts";
import { getStripe } from "./stripe-client.ts";
import { webhookRoutes } from "./webhook.ts";

const billingRoutes = new Hono();

// ─── POST /billing/checkout-session ──────────────────────────────

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

  const { data: plan, error: planErr } = await db
    .from("institution_plans").select("*").eq("id", plan_id).single();

  if (planErr || !plan) return safeErr(c, "Plan lookup", planErr, 404);
  if (!plan.stripe_price_id) return err(c, "Plan does not have a Stripe price configured", 400);

  const { data: existingSub } = await db
    .from("institution_subscriptions")
    .select("stripe_customer_id")
    .eq("user_id", user.id)
    .not("stripe_customer_id", "is", null)
    .limit(1).maybeSingle();

  try {
    const stripe = getStripe();
    const sessionParams: Record<string, unknown> = {
      mode: "subscription",
      "line_items[0][price]": plan.stripe_price_id,
      "line_items[0][quantity]": 1,
      success_url, cancel_url,
      "metadata[institution_id]": institution_id,
      "metadata[plan_id]": plan_id,
      "metadata[user_id]": user.id,
    };
    if (existingSub?.stripe_customer_id) sessionParams.customer = existingSub.stripe_customer_id;
    if (plan.trial_days > 0) sessionParams["subscription_data[trial_period_days]"] = plan.trial_days;

    const session = await stripe.request("POST", "/checkout/sessions", sessionParams);
    return ok(c, { url: session.url, session_id: session.id });
  } catch (e: unknown) {
    return safeErr(c, "Stripe checkout", e instanceof Error ? e : null);
  }
});

// ─── POST /billing/portal-session ────────────────────────────────

billingRoutes.post(`${PREFIX}/billing/portal-session`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const { institution_id, return_url } = body as Record<string, string>;
  if (!isUuid(institution_id)) return err(c, "institution_id must be a valid UUID", 400);
  if (!isNonEmpty(return_url)) return err(c, "return_url is required", 400);

  const { data: sub } = await db
    .from("institution_subscriptions")
    .select("stripe_customer_id")
    .eq("user_id", user.id).eq("institution_id", institution_id)
    .not("stripe_customer_id", "is", null)
    .limit(1).maybeSingle();

  if (!sub?.stripe_customer_id) return err(c, "No Stripe customer found for this user/institution", 404);

  try {
    const stripe = getStripe();
    const session = await stripe.request("POST", "/billing_portal/sessions", {
      customer: sub.stripe_customer_id,
      return_url,
    });
    return ok(c, { url: session.url });
  } catch (e: unknown) {
    return safeErr(c, "Stripe portal", e instanceof Error ? e : null);
  }
});

// ─── GET /billing/subscription-status ────────────────────────────

billingRoutes.get(`${PREFIX}/billing/subscription-status`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const userId = user.id;
  const institutionId = c.req.query("institution_id");
  if (!isUuid(institutionId)) return err(c, "institution_id must be a valid UUID", 400);

  const { data: sub, error: subErr } = await db
    .from("institution_subscriptions")
    .select("*, institution_plans(*)")
    .eq("user_id", userId).eq("institution_id", institutionId)
    .in("status", ["active", "trialing", "past_due"])
    .order("created_at", { ascending: false })
    .limit(1).maybeSingle();

  if (subErr) return safeErr(c, "Subscription lookup", subErr);

  if (!sub) {
    const { data: freePlan } = await db
      .from("institution_plans")
      .select("*")
      .eq("institution_id", institutionId)
      .eq("is_free", true).eq("is_active", true)
      .limit(1).maybeSingle();

    return ok(c, {
      subscription: null, plan: freePlan ?? null,
      features: freePlan?.features ?? null,
      is_active: !!freePlan, is_trial: false, days_remaining: null,
    });
  }

  let daysRemaining: number | null = null;
  const endDate = sub.trial_end ?? sub.current_period_end;
  if (endDate) {
    const diff = new Date(endDate).getTime() - Date.now();
    daysRemaining = Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
  }

  const plan = sub.institution_plans;
  return ok(c, {
    subscription: {
      id: sub.id, status: sub.status,
      stripe_subscription_id: sub.stripe_subscription_id,
      current_period_start: sub.current_period_start,
      current_period_end: sub.current_period_end,
      trial_start: sub.trial_start, trial_end: sub.trial_end,
      cancel_at_period_end: sub.cancel_at_period_end,
      canceled_at: sub.canceled_at,
    },
    plan: plan ? {
      id: plan.id, name: plan.name, description: plan.description,
      price_cents: plan.price_cents, billing_cycle: plan.billing_cycle,
      currency: plan.currency, is_free: plan.is_free, features: plan.features,
    } : null,
    features: plan?.features ?? null,
    is_active: ["active", "trialing"].includes(sub.status),
    is_trial: sub.status === "trialing",
    days_remaining: daysRemaining,
  });
});

// ─── Mount sub-modules ───────────────────────────────────────────

billingRoutes.route("/", webhookRoutes);

export { billingRoutes };

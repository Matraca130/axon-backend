/**
 * routes/plans/crud.ts — Plan table CRUD registrations
 *
 * Factory CRUD for: platform_plans, institution_plans,
 * plan_access_rules, institution_subscriptions.
 */

import type { Context } from "npm:hono";
import { Hono } from "npm:hono";
import { err, PREFIX } from "../../db.ts";
import { registerCrud } from "../../crud-factory.ts";

export const planCrudRoutes = new Hono();

// platform_plans writes are restricted at the DB layer (migration
// 20260326_01_rls_platform_plans_restrict_writes dropped the
// authenticated-user INSERT/UPDATE/DELETE policies, leaving only
// service_role writes). Without an explicit super-admin role in the
// auth model, we also refuse writes at the application layer so
// callers receive a clear 403 instead of an opaque 500 from the RLS
// denial, and so an accidental restoration of permissive RLS policies
// does NOT re-expose the endpoint. (#252)
//
// These handlers are registered BEFORE the registerCrud() call below,
// so they take priority for POST/PUT/DELETE on /platform-plans.
// GET requests fall through to the factory handlers — SELECT remains
// open to authenticated users (students browse plans).
const platformPlansWritesDisabled = (c: Context) =>
  err(
    c,
    "platform_plans writes are administratively restricted. Contact operations for platform-level plan changes.",
    403,
  );

planCrudRoutes.post(`${PREFIX}/platform-plans`, platformPlansWritesDisabled);
planCrudRoutes.put(`${PREFIX}/platform-plans/:id`, platformPlansWritesDisabled);
planCrudRoutes.delete(`${PREFIX}/platform-plans/:id`, platformPlansWritesDisabled);

registerCrud(planCrudRoutes, {
  table: "platform_plans", slug: "platform-plans",
  hasCreatedBy: false, hasUpdatedAt: true, hasOrderIndex: false,
  requiredFields: ["name", "slug"],
  createFields: ["name","slug","description","price_cents","billing_cycle","max_students","max_courses","max_storage_mb","features"],
  updateFields: ["name","slug","description","price_cents","billing_cycle","max_students","max_courses","max_storage_mb","features","is_active"],
});

registerCrud(planCrudRoutes, {
  table: "institution_plans", slug: "institution-plans",
  parentKey: "institution_id", optionalFilters: ["is_free", "is_active"],
  hasCreatedBy: false, hasUpdatedAt: true, hasOrderIndex: false,
  requiredFields: ["name"],
  createFields: ["name","description","price_cents","billing_cycle","is_default","is_free","trial_days","features","sort_order","currency","stripe_product_id","stripe_price_id"],
  updateFields: ["name","description","price_cents","billing_cycle","is_default","is_active","is_free","trial_days","features","sort_order","currency","stripe_product_id","stripe_price_id"],
});

registerCrud(planCrudRoutes, {
  table: "plan_access_rules", slug: "plan-access-rules",
  parentKey: "plan_id",
  hasCreatedBy: false, hasUpdatedAt: false, hasOrderIndex: false,
  requiredFields: ["scope_type", "scope_id"],
  createFields: ["scope_type", "scope_id"],
  updateFields: ["scope_type", "scope_id"],
});

registerCrud(planCrudRoutes, {
  table: "institution_subscriptions", slug: "institution-subscriptions",
  parentKey: "institution_id", optionalFilters: ["status", "user_id"],
  hasCreatedBy: false, hasUpdatedAt: true, hasOrderIndex: false,
  requiredFields: ["plan_id", "user_id"],
  createFields: ["plan_id","user_id","status","current_period_start","current_period_end","stripe_subscription_id","stripe_customer_id","trial_start","trial_end","cancel_at_period_end"],
  updateFields: ["plan_id","status","current_period_start","current_period_end","stripe_subscription_id","stripe_customer_id","trial_start","trial_end","cancel_at_period_end","canceled_at"],
});

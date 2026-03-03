/**
 * routes/plans/crud.ts — Plan table CRUD registrations
 *
 * Factory CRUD for: platform_plans, institution_plans,
 * plan_access_rules, institution_subscriptions.
 */

import { Hono } from "npm:hono";
import { registerCrud } from "../../crud-factory.ts";

export const planCrudRoutes = new Hono();

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

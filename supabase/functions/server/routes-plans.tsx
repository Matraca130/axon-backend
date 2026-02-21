/**
 * routes-plans.tsx — Plans, Billing & AI generation logs for Axon v4.4
 *
 * Factory tables (full CRUD):
 *   platform_plans            — global pricing catalog (no parentKey)
 *   institution_plans         — institution-specific plans
 *   plan_access_rules         — content scoping per plan (hard delete)
 *   institution_subscriptions — active subscriptions
 *
 * Custom tables (LIST + POST only — immutable logs):
 *   ai_generations            — AI generation audit log
 *   summary_diagnostics       — AI diagnostic results
 */

import { Hono } from "npm:hono";
import { authenticate, ok, err, safeJson, PREFIX } from "./db.ts";
import { registerCrud } from "./crud-factory.ts";
import { isUuid, isNonEmpty, isNonNegInt, isObj, validateFields } from "./validate.ts";
import type { Context } from "npm:hono";

const planRoutes = new Hono();

// ═════════════════════════════════════════════════════════════════════
// FACTORY TABLES
// ═════════════════════════════════════════════════════════════════════

// 1. Platform Plans — global catalog (no parentKey, no soft-delete)
//    Anyone can list (see pricing). Create/update restricted by RLS to platform admins.
registerCrud(planRoutes, {
  table: "platform_plans",
  slug: "platform-plans",
  // No parentKey — global catalog
  hasCreatedBy: false,
  hasUpdatedAt: true,
  hasOrderIndex: false,
  requiredFields: ["name", "slug"],
  createFields: [
    "name",
    "slug",
    "description",
    "price_cents",
    "billing_cycle",
    "max_students",
    "max_courses",
    "max_storage_mb",
    "features",
  ],
  updateFields: [
    "name",
    "slug",
    "description",
    "price_cents",
    "billing_cycle",
    "max_students",
    "max_courses",
    "max_storage_mb",
    "features",
    "is_active",
  ],
});

// 2. Institution Plans — institution-specific pricing tiers
registerCrud(planRoutes, {
  table: "institution_plans",
  slug: "institution-plans",
  parentKey: "institution_id",
  hasCreatedBy: false,
  hasUpdatedAt: true,
  hasOrderIndex: false,
  requiredFields: ["name"],
  createFields: [
    "name",
    "description",
    "price_cents",
    "billing_cycle",
    "is_default",
  ],
  updateFields: [
    "name",
    "description",
    "price_cents",
    "billing_cycle",
    "is_default",
    "is_active",
  ],
});

// 3. Plan Access Rules — content scoping per plan (configuration, hard delete)
registerCrud(planRoutes, {
  table: "plan_access_rules",
  slug: "plan-access-rules",
  parentKey: "plan_id",
  hasCreatedBy: false,
  hasUpdatedAt: false,
  hasOrderIndex: false,
  requiredFields: ["scope_type", "scope_id"],
  createFields: ["scope_type", "scope_id"],
  updateFields: ["scope_type", "scope_id"],
});

// 4. Institution Subscriptions — active subscription records
registerCrud(planRoutes, {
  table: "institution_subscriptions",
  slug: "institution-subscriptions",
  parentKey: "institution_id",
  hasCreatedBy: false,
  hasUpdatedAt: true,
  hasOrderIndex: false,
  requiredFields: ["plan_id"],
  createFields: [
    "plan_id",
    "status",
    "current_period_start",
    "current_period_end",
  ],
  updateFields: [
    "plan_id",
    "status",
    "current_period_start",
    "current_period_end",
  ],
});

// ═════════════════════════════════════════════════════════════════════
// AI GENERATION LOGS (LIST + POST — immutable audit records)
// ═════════════════════════════════════════════════════════════════════

// ── 5. AI Generations ─────────────────────────────────────────────
// Log of all AI-generated content. requested_by auto-set from auth.

const aiGenBase = `${PREFIX}/ai-generations`;

planRoutes.get(aiGenBase, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const institutionId = c.req.query("institution_id");
  if (!isUuid(institutionId)) {
    return err(c, "institution_id must be a valid UUID", 400);
  }

  let query = db
    .from("ai_generations")
    .select("*")
    .eq("institution_id", institutionId)
    .order("created_at", { ascending: false });

  // Optional filters
  const genType = c.req.query("generation_type");
  if (genType) query = query.eq("generation_type", genType);

  // Pagination
  const limit = parseInt(c.req.query("limit") ?? "50", 10);
  const offset = parseInt(c.req.query("offset") ?? "0", 10);
  query = query.range(offset, offset + limit - 1);

  const { data, error } = await query;
  if (error)
    return err(c, `List ai_generations failed: ${error.message}`, 500);
  return ok(c, data);
});

planRoutes.post(aiGenBase, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  if (!isUuid(body.institution_id))
    return err(c, "institution_id must be a valid UUID", 400);
  if (!isNonEmpty(body.generation_type))
    return err(c, "generation_type must be a non-empty string", 400);

  const row: Record<string, unknown> = {
    institution_id: body.institution_id,
    requested_by: user.id,
    generation_type: body.generation_type,
  };

  // Optional fields with proper validation
  const { fields, error: valErr } = validateFields(body, [
    { key: "source_summary_id", check: isUuid, msg: "must be a valid UUID" },
    { key: "source_keyword_id", check: isUuid, msg: "must be a valid UUID" },
    { key: "items_generated", check: isNonNegInt, msg: "must be a non-negative integer" },
    { key: "model_used", check: isNonEmpty, msg: "must be a non-empty string" },
  ]);
  if (valErr) return err(c, valErr, 400);
  Object.assign(row, fields);

  const { data, error } = await db
    .from("ai_generations")
    .insert(row)
    .select()
    .single();

  if (error)
    return err(c, `Create ai_generation failed: ${error.message}`, 500);
  return ok(c, data, 201);
});

// ── 6. Summary Diagnostics ────────────────────────────────────────
// AI-generated diagnostics for summaries. requested_by auto-set from auth.

const diagBase = `${PREFIX}/summary-diagnostics`;

planRoutes.get(diagBase, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const summaryId = c.req.query("summary_id");
  if (!isUuid(summaryId)) {
    return err(c, "summary_id must be a valid UUID", 400);
  }

  let query = db
    .from("summary_diagnostics")
    .select("*")
    .eq("summary_id", summaryId)
    .order("created_at", { ascending: false });

  // Optional filter by type
  const diagType = c.req.query("diagnostic_type");
  if (diagType) query = query.eq("diagnostic_type", diagType);

  const { data, error } = await query;
  if (error)
    return err(c, `List summary_diagnostics failed: ${error.message}`, 500);
  return ok(c, data);
});

planRoutes.post(diagBase, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  if (!isUuid(body.summary_id))
    return err(c, "summary_id must be a valid UUID", 400);
  if (!isNonEmpty(body.content))
    return err(c, "content must be a non-empty string", 400);

  const row: Record<string, unknown> = {
    summary_id: body.summary_id,
    requested_by: user.id,
    content: body.content,
  };

  // Optional fields with proper validation
  const { fields, error: valErr } = validateFields(body, [
    { key: "ai_generation_id", check: isUuid, msg: "must be a valid UUID" },
    { key: "parent_diagnostic_id", check: isUuid, msg: "must be a valid UUID" },
    { key: "diagnostic_type", check: isNonEmpty, msg: "must be a non-empty string" },
    { key: "structured_data", check: isObj, msg: "must be a JSON object" },
    { key: "model_used", check: isNonEmpty, msg: "must be a non-empty string" },
    { key: "prompt_version", check: isNonEmpty, msg: "must be a non-empty string" },
  ]);
  if (valErr) return err(c, valErr, 400);
  Object.assign(row, fields);

  const { data, error } = await db
    .from("summary_diagnostics")
    .insert(row)
    .select()
    .single();

  if (error)
    return err(c, `Create summary_diagnostic failed: ${error.message}`, 500);
  return ok(c, data, 201);
});

export { planRoutes };

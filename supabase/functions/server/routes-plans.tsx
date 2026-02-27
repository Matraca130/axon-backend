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
 *
 * P-2 FIX: ai-generations pagination capped at 500.
 * P-8 FIX: usage-today uses proper tomorrow boundary.
 */

import { Hono } from "npm:hono";
import { authenticate, ok, err, safeJson, PREFIX } from "./db.ts";
import { registerCrud } from "./crud-factory.ts";
import { isUuid, isNonEmpty, isNonNegInt, isObj, validateFields } from "./validate.ts";
import type { Context } from "npm:hono";

const planRoutes = new Hono();

const MAX_PAGINATION_LIMIT = 500;

// ═════════════════════════════════════════════════════════════════════
// FACTORY TABLES
// ═════════════════════════════════════════════════════════════════════

registerCrud(planRoutes, {
  table: "platform_plans",
  slug: "platform-plans",
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

registerCrud(planRoutes, {
  table: "institution_plans",
  slug: "institution-plans",
  parentKey: "institution_id",
  optionalFilters: ["is_free", "is_active"],
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
    "is_free",
    "trial_days",
    "features",
    "sort_order",
    "currency",
    "stripe_product_id",
    "stripe_price_id",
  ],
  updateFields: [
    "name",
    "description",
    "price_cents",
    "billing_cycle",
    "is_default",
    "is_active",
    "is_free",
    "trial_days",
    "features",
    "sort_order",
    "currency",
    "stripe_product_id",
    "stripe_price_id",
  ],
});

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

registerCrud(planRoutes, {
  table: "institution_subscriptions",
  slug: "institution-subscriptions",
  parentKey: "institution_id",
  optionalFilters: ["status", "user_id"],
  hasCreatedBy: false,
  hasUpdatedAt: true,
  hasOrderIndex: false,
  requiredFields: ["plan_id", "user_id"],
  createFields: [
    "plan_id",
    "user_id",
    "status",
    "current_period_start",
    "current_period_end",
    "stripe_subscription_id",
    "stripe_customer_id",
    "trial_start",
    "trial_end",
    "cancel_at_period_end",
  ],
  updateFields: [
    "plan_id",
    "status",
    "current_period_start",
    "current_period_end",
    "stripe_subscription_id",
    "stripe_customer_id",
    "trial_start",
    "trial_end",
    "cancel_at_period_end",
    "canceled_at",
  ],
});

// ═════════════════════════════════════════════════════════════════════
// AI GENERATION LOGS (LIST + POST — immutable audit records)
// ═════════════════════════════════════════════════════════════════════

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

  const genType = c.req.query("generation_type");
  if (genType) query = query.eq("generation_type", genType);

  // P-2 FIX: Pagination with cap
  let limit = parseInt(c.req.query("limit") ?? "50", 10);
  if (isNaN(limit) || limit < 1) limit = 50;
  if (limit > MAX_PAGINATION_LIMIT) limit = MAX_PAGINATION_LIMIT;
  let offset = parseInt(c.req.query("offset") ?? "0", 10);
  if (isNaN(offset) || offset < 0) offset = 0;
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

// ═════════════════════════════════════════════════════════════════════
// EV-13: COMPUTED ROUTES — Content Access + Usage Today
// ═════════════════════════════════════════════════════════════════════

planRoutes.get(`${PREFIX}/content-access`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const userId = c.req.query("user_id");
  const institutionId = c.req.query("institution_id");

  if (!isUuid(userId)) return err(c, "user_id must be a valid UUID", 400);
  if (!isUuid(institutionId)) return err(c, "institution_id must be a valid UUID", 400);

  const { data: sub, error: subErr } = await db
    .from("institution_subscriptions")
    .select("id, plan_id, status, current_period_end")
    .eq("user_id", userId)
    .eq("institution_id", institutionId)
    .in("status", ["active", "trialing"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (subErr) return err(c, `Subscription lookup failed: ${subErr.message}`, 500);

  if (!sub) {
    return ok(c, { access: "none", rules: [], plan_name: null, features: null });
  }

  if (sub.current_period_end && new Date(sub.current_period_end) < new Date()) {
    await db
      .from("institution_subscriptions")
      .update({ status: "expired" })
      .eq("id", sub.id);
    return ok(c, { access: "none", rules: [], plan_name: null, features: null });
  }

  const { data: plan, error: planErr } = await db
    .from("institution_plans")
    .select("name, features")
    .eq("id", sub.plan_id)
    .single();

  if (planErr || !plan) return err(c, "Plan not found", 404);

  const features = (plan.features as Record<string, unknown>) ?? {};
  const contentGating = features.content_gating as string | undefined;

  if (!contentGating || contentGating === "full") {
    return ok(c, { access: "full", rules: [], plan_name: plan.name, features });
  }

  const { data: rules, error: rulesErr } = await db
    .from("plan_access_rules")
    .select("scope_type, scope_id")
    .eq("plan_id", sub.plan_id);

  if (rulesErr) return err(c, `Rules lookup failed: ${rulesErr.message}`, 500);

  return ok(c, {
    access: "restricted",
    rules: rules ?? [],
    plan_name: plan.name,
    features,
  });
});

// ── GET /usage-today ──────────────────────────────────────────────
planRoutes.get(`${PREFIX}/usage-today`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const userId = c.req.query("user_id");
  const institutionId = c.req.query("institution_id");

  if (!isUuid(userId)) return err(c, "user_id must be a valid UUID", 400);
  if (!isUuid(institutionId)) return err(c, "institution_id must be a valid UUID", 400);

  // P-8 FIX: Compute proper date boundaries
  const todayDate = new Date();
  const today = todayDate.toISOString().split("T")[0];
  todayDate.setUTCDate(todayDate.getUTCDate() + 1);
  const tomorrow = todayDate.toISOString().split("T")[0];

  const [quizRes, flashRes, aiRes] = await Promise.all([
    db
      .from("quiz_attempts")
      .select("id", { count: "exact", head: true })
      .eq("student_id", userId)
      .gte("created_at", `${today}T00:00:00Z`)
      .lt("created_at", `${tomorrow}T00:00:00Z`),

    db
      .from("daily_activities")
      .select("reviews_count")
      .eq("student_id", userId)
      .eq("activity_date", today)
      .maybeSingle(),

    db
      .from("ai_generations")
      .select("id", { count: "exact", head: true })
      .eq("requested_by", userId)
      .gte("created_at", `${today}T00:00:00Z`)
      .lt("created_at", `${tomorrow}T00:00:00Z`),
  ]);

  return ok(c, {
    date: today,
    quizzes_taken: quizRes.count ?? 0,
    flashcard_reviews: flashRes.data?.reviews_count ?? 0,
    ai_generations: aiRes.count ?? 0,
  });
});

export { planRoutes };

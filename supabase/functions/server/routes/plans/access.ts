/**
 * routes/plans/access.ts — Content access & usage tracking
 *
 * GET /content-access   — Check user's subscription + plan rules
 * GET /usage-today      — Today's quiz, flashcard, AI usage counts
 *
 * P-8 FIX: usage-today uses proper tomorrow boundary.
 *
 * W7-SEC01 FIX: Both endpoints now use auth user.id instead of
 * c.req.query("user_id"). The old pattern allowed any authenticated
 * user to query any other user's subscription and usage data (IDOR).
 */

import { Hono } from "npm:hono";
import { authenticate, ok, err, PREFIX } from "../../db.ts";
import { isUuid } from "../../validate.ts";
import type { Context } from "npm:hono";

export const accessRoutes = new Hono();

accessRoutes.get(`${PREFIX}/content-access`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  // W7-SEC01 FIX: Use authenticated user.id instead of query param
  const userId = user.id;
  const institutionId = c.req.query("institution_id");
  if (!isUuid(institutionId)) return err(c, "institution_id must be a valid UUID", 400);

  const { data: sub, error: subErr } = await db
    .from("institution_subscriptions")
    .select("id, plan_id, status, current_period_end")
    .eq("user_id", userId).eq("institution_id", institutionId)
    .in("status", ["active", "trialing"])
    .order("created_at", { ascending: false }).limit(1).maybeSingle();

  if (subErr) return err(c, `Subscription lookup failed: ${subErr.message}`, 500);
  if (!sub) return ok(c, { access: "none", rules: [], plan_name: null, features: null });

  if (sub.current_period_end && new Date(sub.current_period_end) < new Date()) {
    await db.from("institution_subscriptions").update({ status: "expired" }).eq("id", sub.id);
    return ok(c, { access: "none", rules: [], plan_name: null, features: null });
  }

  const { data: plan, error: planErr } = await db
    .from("institution_plans").select("name, features").eq("id", sub.plan_id).single();
  if (planErr || !plan) return err(c, "Plan not found", 404);

  const features = (plan.features as Record<string, unknown>) ?? {};
  const contentGating = features.content_gating as string | undefined;

  if (!contentGating || contentGating === "full")
    return ok(c, { access: "full", rules: [], plan_name: plan.name, features });

  const { data: rules, error: rulesErr } = await db
    .from("plan_access_rules").select("scope_type, scope_id").eq("plan_id", sub.plan_id);
  if (rulesErr) return err(c, `Rules lookup failed: ${rulesErr.message}`, 500);

  return ok(c, { access: "restricted", rules: rules ?? [], plan_name: plan.name, features });
});

accessRoutes.get(`${PREFIX}/usage-today`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  // W7-SEC01 FIX: Destructure user (was missing) to use user.id
  const { user, db } = auth;

  // W7-SEC01 FIX: Use authenticated user.id instead of query param
  const userId = user.id;
  const institutionId = c.req.query("institution_id");
  if (!isUuid(institutionId)) return err(c, "institution_id must be a valid UUID", 400);

  const todayDate = new Date();
  const today = todayDate.toISOString().split("T")[0];
  todayDate.setUTCDate(todayDate.getUTCDate() + 1);
  const tomorrow = todayDate.toISOString().split("T")[0];

  const [quizRes, flashRes, aiRes] = await Promise.all([
    db.from("quiz_attempts").select("id", { count: "exact", head: true })
      .eq("student_id", userId)
      .gte("created_at", `${today}T00:00:00Z`).lt("created_at", `${tomorrow}T00:00:00Z`),
    db.from("daily_activities").select("reviews_count")
      .eq("student_id", userId).eq("activity_date", today).maybeSingle(),
    db.from("ai_generations").select("id", { count: "exact", head: true })
      .eq("requested_by", userId)
      .gte("created_at", `${today}T00:00:00Z`).lt("created_at", `${tomorrow}T00:00:00Z`),
  ]);

  return ok(c, {
    date: today,
    quizzes_taken: quizRes.count ?? 0,
    flashcard_reviews: flashRes.data?.reviews_count ?? 0,
    ai_generations: aiRes.count ?? 0,
  });
});

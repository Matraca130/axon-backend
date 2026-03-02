/**
 * routes/study/progress.ts — Student progress tracking
 *
 * UPSERT TABLES — atomic .upsert({ onConflict }):
 *   reading_states    — per-summary reading progress
 *   daily_activities  — per-day activity log
 *   student_stats     — aggregated stats per student
 *
 * P-2 FIX: Pagination caps added to daily-activities.
 */

import { Hono } from "npm:hono";
import type { SupabaseClient } from "npm:@supabase/supabase-js";
import { authenticate, ok, err, safeJson, PREFIX } from "../../db.ts";
import {
  isUuid,
  isNonNeg,
  isNonNegInt,
  isBool,
  isIsoTs,
  isDateOnly,
  validateFields,
} from "../../validate.ts";
import type { Context } from "npm:hono";

export const progressRoutes = new Hono();

const MAX_PAGINATION_LIMIT = 500;

// ─── Shared Helper ────────────────────────────────────────────────────

export async function atomicUpsert(
  db: SupabaseClient,
  table: string,
  onConflict: string,
  row: Record<string, unknown>,
): Promise<{ data: unknown; error: { message: string } | null }> {
  row.updated_at = new Date().toISOString();
  const { data, error } = await db
    .from(table)
    .upsert(row, { onConflict })
    .select()
    .single();
  return { data, error };
}

// ─── Reading States ───────────────────────────────────────────────────

progressRoutes.get(`${PREFIX}/reading-states`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const summaryId = c.req.query("summary_id");
  if (!isUuid(summaryId)) return err(c, "summary_id must be a valid UUID", 400);

  const { data, error } = await db
    .from("reading_states")
    .select("*")
    .eq("student_id", user.id)
    .eq("summary_id", summaryId)
    .maybeSingle();

  if (error) return err(c, `Get reading_state failed: ${error.message}`, 500);
  return ok(c, data);
});

progressRoutes.post(`${PREFIX}/reading-states`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);
  if (!isUuid(body.summary_id))
    return err(c, "summary_id must be a valid UUID", 400);

  const { fields, error: valErr } = validateFields(body, [
    { key: "scroll_position", check: isNonNeg, msg: "must be ≥ 0" },
    { key: "time_spent_seconds", check: isNonNeg, msg: "must be ≥ 0" },
    { key: "completed", check: isBool, msg: "must be a boolean" },
    { key: "last_read_at", check: isIsoTs, msg: "must be an ISO timestamp" },
  ]);
  if (valErr) return err(c, valErr, 400);

  const row = { student_id: user.id, summary_id: body.summary_id, ...fields };
  const { data, error } = await atomicUpsert(db, "reading_states", "student_id,summary_id", row);
  if (error) return err(c, `Upsert reading_state failed: ${error.message}`, 500);
  return ok(c, data);
});

// ─── Daily Activities ────────────────────────────────────────────────

progressRoutes.get(`${PREFIX}/daily-activities`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  let query = db.from("daily_activities").select("*").eq("student_id", user.id)
    .order("activity_date", { ascending: false });

  const from = c.req.query("from");
  const to = c.req.query("to");
  if (from) {
    if (!isDateOnly(from)) return err(c, "from must be YYYY-MM-DD format", 400);
    query = query.gte("activity_date", from);
  }
  if (to) {
    if (!isDateOnly(to)) return err(c, "to must be YYYY-MM-DD format", 400);
    query = query.lte("activity_date", to);
  }

  let limit = parseInt(c.req.query("limit") ?? "90", 10);
  if (isNaN(limit) || limit < 1) limit = 90;
  if (limit > MAX_PAGINATION_LIMIT) limit = MAX_PAGINATION_LIMIT;
  let offset = parseInt(c.req.query("offset") ?? "0", 10);
  if (isNaN(offset) || offset < 0) offset = 0;
  query = query.range(offset, offset + limit - 1);

  const { data, error } = await query;
  if (error) return err(c, `List daily_activities failed: ${error.message}`, 500);
  return ok(c, data);
});

progressRoutes.post(`${PREFIX}/daily-activities`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);
  if (!isDateOnly(body.activity_date))
    return err(c, "activity_date must be YYYY-MM-DD format", 400);

  const { fields, error: valErr } = validateFields(body, [
    { key: "reviews_count", check: isNonNegInt, msg: "must be a non-negative integer" },
    { key: "correct_count", check: isNonNegInt, msg: "must be a non-negative integer" },
    { key: "time_spent_seconds", check: isNonNeg, msg: "must be ≥ 0" },
    { key: "sessions_count", check: isNonNegInt, msg: "must be a non-negative integer" },
  ]);
  if (valErr) return err(c, valErr, 400);

  const row = { student_id: user.id, activity_date: body.activity_date, ...fields };
  const { data, error } = await atomicUpsert(db, "daily_activities", "student_id,activity_date", row);
  if (error) return err(c, `Upsert daily_activity failed: ${error.message}`, 500);
  return ok(c, data);
});

// ─── Student Stats ────────────────────────────────────────────────────

progressRoutes.get(`${PREFIX}/student-stats`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const { data, error } = await db.from("student_stats").select("*")
    .eq("student_id", user.id).maybeSingle();
  if (error) return err(c, `Get student_stats failed: ${error.message}`, 500);
  return ok(c, data);
});

progressRoutes.post(`${PREFIX}/student-stats`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const { fields, error: valErr } = validateFields(body, [
    { key: "current_streak", check: isNonNegInt, msg: "must be a non-negative integer" },
    { key: "longest_streak", check: isNonNegInt, msg: "must be a non-negative integer" },
    { key: "total_reviews", check: isNonNegInt, msg: "must be a non-negative integer" },
    { key: "total_time_seconds", check: isNonNeg, msg: "must be ≥ 0" },
    { key: "total_sessions", check: isNonNegInt, msg: "must be a non-negative integer" },
    { key: "last_study_date", check: isDateOnly, msg: "must be YYYY-MM-DD format" },
  ]);
  if (valErr) return err(c, valErr, 400);

  const row = { student_id: user.id, ...fields };
  const { data, error } = await atomicUpsert(db, "student_stats", "student_id", row);
  if (error) return err(c, `Upsert student_stats failed: ${error.message}`, 500);
  return ok(c, data);
});

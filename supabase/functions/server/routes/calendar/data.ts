/**
 * routes/calendar/data.ts — GET /calendar/data
 *
 * Unified calendar endpoint that returns exam events, heatmap data,
 * and pending study tasks for a date range in a single request.
 *
 * Query params:
 *   from  — YYYY-MM-DD (required)
 *   to    — YYYY-MM-DD (required)
 *   types — 'all' | 'events' | 'heatmap' | 'tasks' (default: 'all')
 *
 * Response: { events: ExamEvent[], heatmap: FsrsState[], tasks: Task[] }
 *
 * Circuit breaker: each query has an 8s timeout. If a query fails or
 * times out, it returns an empty array (partial response, not 500).
 *
 * Session: S-0A (Calendar v2)
 * FILE: supabase/functions/server/routes/calendar/data.ts
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import type { SupabaseClient } from "npm:@supabase/supabase-js";
import { authenticate, ok, err, PREFIX } from "../../db.ts";
import { isDateOnly } from "../../validate.ts";

export const calendarDataRoutes = new Hono();

// ─── Constants ───────────────────────────────────────────────────
const QUERY_TIMEOUT_MS = 8_000;
const VALID_TYPES = new Set(["all", "events", "heatmap", "tasks"]);

// ─── Timeout helper ──────────────────────────────────────────────

/**
 * Race a promise against a timeout. Returns fallback on timeout or error.
 * This is the circuit breaker: each sub-query gets its own 8s budget.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T,
  label: string,
): Promise<T> {
  const timer = new Promise<T>((resolve) =>
    setTimeout(() => {
      console.warn(`[calendar] ${label} timed out after ${timeoutMs}ms — using fallback`);
      resolve(fallback);
    }, timeoutMs),
  );
  try {
    return await Promise.race([promise, timer]);
  } catch (e) {
    console.error(`[calendar] ${label} failed: ${(e as Error).message ?? e}`);
    return fallback;
  }
}

// ─── Sub-queries ─────────────────────────────────────────────────

/** Query 1: exam_events in the date range for the authenticated student */
async function fetchExamEvents(
  db: SupabaseClient,
  userId: string,
  from: string,
  to: string,
): Promise<unknown[]> {
  const { data, error } = await db
    .from("exam_events")
    .select("*")
    .eq("student_id", userId)
    .gte("date", from)
    .lte("date", to)
    .order("date", { ascending: true });

  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Query 2: fsrs_states for heatmap (cards due in range) */
async function fetchHeatmapData(
  db: SupabaseClient,
  userId: string,
  from: string,
  to: string,
): Promise<unknown[]> {
  const { data, error } = await db
    .from("fsrs_states")
    .select("id, flashcard_id, due_at, stability, state")
    .eq("student_id", userId)
    .gte("due_at", `${from}T00:00:00`)
    .lte("due_at", `${to}T23:59:59`)
    .order("due_at", { ascending: true });

  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Query 3: pending study_plan_tasks in the date range */
async function fetchPendingTasks(
  db: SupabaseClient,
  userId: string,
  from: string,
  to: string,
): Promise<unknown[]> {
  const { data, error } = await db
    .from("study_plan_tasks")
    .select("*, study_plans!inner(student_id)")
    .eq("study_plans.student_id", userId)
    .neq("status", "completed")
    .gte("scheduled_date", from)
    .lte("scheduled_date", to)
    .order("scheduled_date", { ascending: true });

  if (error) throw new Error(error.message);
  return data ?? [];
}

// ─── Route ───────────────────────────────────────────────────────

calendarDataRoutes.get(`${PREFIX}/calendar/data`, async (c: Context) => {
  // Auth
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  // Validate query params
  const from = c.req.query("from");
  const to = c.req.query("to");
  const types = c.req.query("types") ?? "all";

  if (!from || !isDateOnly(from)) {
    return err(c, "Missing or invalid 'from' param (YYYY-MM-DD)", 400);
  }
  if (!to || !isDateOnly(to)) {
    return err(c, "Missing or invalid 'to' param (YYYY-MM-DD)", 400);
  }
  if (from > to) {
    return err(c, "'from' must be <= 'to'", 400);
  }
  if (!VALID_TYPES.has(types)) {
    return err(c, `Invalid 'types' param. Valid: ${[...VALID_TYPES].join(", ")}`, 400);
  }

  // Build queries based on requested types
  const wantEvents = types === "all" || types === "events";
  const wantHeatmap = types === "all" || types === "heatmap";
  const wantTasks = types === "all" || types === "tasks";

  const [events, heatmap, tasks] = await Promise.all([
    wantEvents
      ? withTimeout(fetchExamEvents(db, user.id, from, to), QUERY_TIMEOUT_MS, [], "exam_events")
      : Promise.resolve([]),
    wantHeatmap
      ? withTimeout(fetchHeatmapData(db, user.id, from, to), QUERY_TIMEOUT_MS, [], "fsrs_states")
      : Promise.resolve([]),
    wantTasks
      ? withTimeout(fetchPendingTasks(db, user.id, from, to), QUERY_TIMEOUT_MS, [], "study_plan_tasks")
      : Promise.resolve([]),
  ]);

  return ok(c, { events, heatmap, tasks });
});

/**
 * routes-study.tsx — Study sessions, progress & spaced repetition for Axon v4.4
 *
 * Factory tables (full CRUD):
 *   study_sessions    — per-student session log
 *   study_plans       — per-student study plans
 *   study_plan_tasks  — tasks within a study plan
 *
 * Create-only tables (LIST + POST, no update/delete):
 *   reviews           — grade records within a session (immutable)
 *   quiz_attempts     — student answers to quiz questions (immutable)
 *
 * Upsert tables (GET/LIST + POST atomic upsert):
 *   reading_states    — scroll position + time per summary (one per student+summary)
 *   daily_activities  — daily aggregates (one per student+date)
 *   student_stats     — lifetime aggregates (one per student)
 *   fsrs_states       — FSRS spaced-repetition state per flashcard
 *   bkt_states        — Bayesian Knowledge Tracing state per subtopic
 *
 * Upsert strategy:
 *   Uses Supabase .upsert({ onConflict }) for atomicity.
 *   REQUIRES UNIQUE constraints on the conflict columns:
 *     - reading_states:   UNIQUE(student_id, summary_id)
 *     - daily_activities: UNIQUE(student_id, activity_date)
 *     - student_stats:    UNIQUE(student_id)
 *     - fsrs_states:      UNIQUE(student_id, flashcard_id)
 *     - bkt_states:       UNIQUE(student_id, subtopic_id)
 *   Without these constraints, PostgREST returns:
 *     "there is no unique or exclusion constraint matching the ON CONFLICT specification"
 */

import { Hono } from "npm:hono";
import type { SupabaseClient } from "npm:@supabase/supabase-js";
import { authenticate, ok, err, safeJson, PREFIX } from "./db.ts";
import { registerCrud } from "./crud-factory.ts";
import {
  isUuid,
  isNonEmpty,
  isNonNeg,
  isNonNegInt,
  isNum,
  isBool,
  isIsoTs,
  isDateOnly,
  isProbability,
  inRange,
  isOneOf,
  validateFields,
} from "./validate.ts";
import type { Context } from "npm:hono";

const studyRoutes = new Hono();

// ─── Atomic Upsert Helper ──────────────────────────────────────────
/**
 * Atomic INSERT ... ON CONFLICT DO UPDATE via Supabase .upsert().
 * Zero race conditions — the DB handles conflict detection in a single statement.
 *
 * @param onConflict — comma-separated column names matching a UNIQUE constraint
 *                     (e.g. "student_id,summary_id")
 * @param row        — full row including both conflict keys and data columns.
 *                     Only columns present in the row are updated on conflict.
 */
async function atomicUpsert(
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

// ═════════════════════════════════════════════════════════════════════
// FACTORY TABLES
// ═════════════════════════════════════════════════════════════════════

// 1. Study Sessions — per-student activity log
//    No parentKey (course_id is optional). scopeToUser auto-filters.
//    M-5 FIX: removed phantom duration_seconds, ended_at → completed_at
registerCrud(studyRoutes, {
  table: "study_sessions",
  slug: "study-sessions",
  scopeToUser: "student_id",
  optionalFilters: ["course_id", "session_type"],
  hasCreatedBy: false,
  hasUpdatedAt: false,
  hasOrderIndex: false,
  requiredFields: ["session_type"],
  createFields: ["course_id", "session_type"],
  updateFields: [
    "completed_at",
    "total_reviews",
    "correct_reviews",
  ],
});

// 2. Study Plans — per-student, optionally tied to a course
registerCrud(studyRoutes, {
  table: "study_plans",
  slug: "study-plans",
  scopeToUser: "student_id",
  optionalFilters: ["course_id", "status"],
  hasCreatedBy: false,
  hasUpdatedAt: true,
  hasOrderIndex: false,
  requiredFields: ["name"],
  createFields: ["course_id", "name", "status"],
  updateFields: ["name", "status"],
});

// 3. Study Plan Tasks — child of study_plan, orderable
//    No scopeToUser (access controlled by parent study_plan + RLS).
registerCrud(studyRoutes, {
  table: "study_plan_tasks",
  slug: "study-plan-tasks",
  parentKey: "study_plan_id",
  hasCreatedBy: false,
  hasUpdatedAt: false,
  hasOrderIndex: true,
  requiredFields: ["item_type", "item_id"],
  createFields: ["item_type", "item_id", "status", "order_index"],
  updateFields: ["status", "order_index", "completed_at"],
});

// ═════════════════════════════════════════════════════════════════════
// CREATE-ONLY TABLES (LIST + POST — no update, no delete)
// ═════════════════════════════════════════════════════════════════════

// ── 4. Reviews ────────────────────────────────────────────────────
// Immutable grade records. LIST by session_id.

studyRoutes.get(`${PREFIX}/reviews`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const sessionId = c.req.query("session_id");
  if (!isUuid(sessionId)) {
    return err(c, "session_id must be a valid UUID", 400);
  }

  const { data, error } = await db
    .from("reviews")
    .select("*")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });

  if (error) return err(c, `List reviews failed: ${error.message}`, 500);
  return ok(c, data);
});

studyRoutes.post(`${PREFIX}/reviews`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  if (!isUuid(body.session_id))
    return err(c, "session_id must be a valid UUID", 400);
  if (!isUuid(body.item_id))
    return err(c, "item_id must be a valid UUID", 400);
  if (!isNonEmpty(body.instrument_type))
    return err(c, "instrument_type must be a non-empty string", 400);
  if (!inRange(body.grade, 0, 5))
    return err(c, "grade must be a number in [0, 5]", 400);

  const { data, error } = await db
    .from("reviews")
    .insert({
      session_id: body.session_id,
      item_id: body.item_id,
      instrument_type: body.instrument_type,
      grade: body.grade,
    })
    .select()
    .single();

  if (error) return err(c, `Create review failed: ${error.message}`, 500);
  return ok(c, data, 201);
});

// ── 5. Quiz Attempts ──────────────────────────────────────────────
// Immutable answer records. Scoped to student.

studyRoutes.get(`${PREFIX}/quiz-attempts`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const questionId = c.req.query("quiz_question_id");
  const sessionId = c.req.query("session_id");

  if (!questionId && !sessionId) {
    return err(
      c,
      "At least one filter required: quiz_question_id or session_id",
      400,
    );
  }

  // Validate provided filters are UUIDs
  if (questionId && !isUuid(questionId))
    return err(c, "quiz_question_id must be a valid UUID", 400);
  if (sessionId && !isUuid(sessionId))
    return err(c, "session_id must be a valid UUID", 400);

  let query = db
    .from("quiz_attempts")
    .select("*")
    .eq("student_id", user.id)
    .order("created_at", { ascending: true });

  if (questionId) query = query.eq("quiz_question_id", questionId);
  if (sessionId) query = query.eq("session_id", sessionId);

  const { data, error } = await query;
  if (error)
    return err(c, `List quiz_attempts failed: ${error.message}`, 500);
  return ok(c, data);
});

studyRoutes.post(`${PREFIX}/quiz-attempts`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  // Required fields
  if (!isUuid(body.quiz_question_id))
    return err(c, "quiz_question_id must be a valid UUID", 400);
  if (!isNonEmpty(body.answer))
    return err(c, "answer must be a non-empty string", 400);
  if (!isBool(body.is_correct))
    return err(c, "is_correct must be a boolean", 400);

  const row: Record<string, unknown> = {
    student_id: user.id,
    quiz_question_id: body.quiz_question_id,
    answer: body.answer,
    is_correct: body.is_correct,
  };

  // Optional fields with validation
  if (body.session_id !== undefined) {
    if (!isUuid(body.session_id))
      return err(c, "session_id must be a valid UUID", 400);
    row.session_id = body.session_id;
  }
  if (body.time_taken_ms !== undefined) {
    if (!isNonNegInt(body.time_taken_ms))
      return err(c, "time_taken_ms must be a non-negative integer", 400);
    row.time_taken_ms = body.time_taken_ms;
  }

  const { data, error } = await db
    .from("quiz_attempts")
    .insert(row)
    .select()
    .single();

  if (error)
    return err(c, `Create quiz_attempt failed: ${error.message}`, 500);
  return ok(c, data, 201);
});

// ═════════════════════════════════════════════════════════════════════
// UPSERT TABLES — atomic .upsert({ onConflict })
// ═════════════════════════════════════════════════════════════════════

// ── 6. Reading States ─────────────────────────────────────────────
// One per student + summary. Tracks scroll position, time, completion.
// UNIQUE(student_id, summary_id) required.

studyRoutes.get(`${PREFIX}/reading-states`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const summaryId = c.req.query("summary_id");
  if (!isUuid(summaryId)) {
    return err(c, "summary_id must be a valid UUID", 400);
  }

  const { data, error } = await db
    .from("reading_states")
    .select("*")
    .eq("student_id", user.id)
    .eq("summary_id", summaryId)
    .maybeSingle();

  if (error)
    return err(c, `Get reading_state failed: ${error.message}`, 500);
  return ok(c, data); // null if never read
});

studyRoutes.post(`${PREFIX}/reading-states`, async (c: Context) => {
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
  const { data, error } = await atomicUpsert(
    db,
    "reading_states",
    "student_id,summary_id",
    row,
  );

  if (error)
    return err(c, `Upsert reading_state failed: ${error.message}`, 500);
  return ok(c, data);
});

// ── 7. Daily Activities ───────────────────────────────────────────
// One per student + date. Frontend sends full totals (not increments).
// UNIQUE(student_id, activity_date) required.

studyRoutes.get(`${PREFIX}/daily-activities`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  let query = db
    .from("daily_activities")
    .select("*")
    .eq("student_id", user.id)
    .order("activity_date", { ascending: false });

  // Optional date range — validate format if provided
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (from) {
    if (!isDateOnly(from))
      return err(c, "from must be YYYY-MM-DD format", 400);
    query = query.gte("activity_date", from);
  }
  if (to) {
    if (!isDateOnly(to)) return err(c, "to must be YYYY-MM-DD format", 400);
    query = query.lte("activity_date", to);
  }

  // Pagination
  const limit = parseInt(c.req.query("limit") ?? "90", 10);
  const offset = parseInt(c.req.query("offset") ?? "0", 10);
  query = query.range(offset, offset + limit - 1);

  const { data, error } = await query;
  if (error)
    return err(c, `List daily_activities failed: ${error.message}`, 500);
  return ok(c, data);
});

studyRoutes.post(`${PREFIX}/daily-activities`, async (c: Context) => {
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

  const row = {
    student_id: user.id,
    activity_date: body.activity_date,
    ...fields,
  };
  const { data, error } = await atomicUpsert(
    db,
    "daily_activities",
    "student_id,activity_date",
    row,
  );

  if (error)
    return err(c, `Upsert daily_activity failed: ${error.message}`, 500);
  return ok(c, data);
});

// ── 8. Student Stats ──────────────────────────────────────────────
// One per student. Lifetime aggregates.
// UNIQUE(student_id) required.

studyRoutes.get(`${PREFIX}/student-stats`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const { data, error } = await db
    .from("student_stats")
    .select("*")
    .eq("student_id", user.id)
    .maybeSingle();

  if (error)
    return err(c, `Get student_stats failed: ${error.message}`, 500);
  return ok(c, data); // null if no stats yet
});

studyRoutes.post(`${PREFIX}/student-stats`, async (c: Context) => {
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
  const { data, error } = await atomicUpsert(
    db,
    "student_stats",
    "student_id",
    row,
  );

  if (error)
    return err(c, `Upsert student_stats failed: ${error.message}`, 500);
  return ok(c, data);
});

// ── 9. FSRS States ────────────────────────────────────────────────
// One per student + flashcard. FSRS spaced-repetition parameters.
// UNIQUE(student_id, flashcard_id) required.

const FSRS_STATES = ["new", "learning", "review", "relearning"] as const;

studyRoutes.get(`${PREFIX}/fsrs-states`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  let query = db
    .from("fsrs_states")
    .select("*")
    .eq("student_id", user.id)
    .order("due_at", { ascending: true });

  // Optional filters — validate format
  const flashcardId = c.req.query("flashcard_id");
  const state = c.req.query("state");
  const dueBefore = c.req.query("due_before");

  if (flashcardId) {
    if (!isUuid(flashcardId))
      return err(c, "flashcard_id must be a valid UUID", 400);
    query = query.eq("flashcard_id", flashcardId);
  }
  if (state) {
    if (!isOneOf(state, FSRS_STATES))
      return err(
        c,
        `state must be one of: ${FSRS_STATES.join(", ")}`,
        400,
      );
    query = query.eq("state", state);
  }
  if (dueBefore) {
    if (!isIsoTs(dueBefore))
      return err(c, "due_before must be an ISO timestamp", 400);
    query = query.lte("due_at", dueBefore);
  }

  // Pagination
  const limit = parseInt(c.req.query("limit") ?? "100", 10);
  const offset = parseInt(c.req.query("offset") ?? "0", 10);
  query = query.range(offset, offset + limit - 1);

  const { data, error } = await query;
  if (error)
    return err(c, `List fsrs_states failed: ${error.message}`, 500);
  return ok(c, data);
});

studyRoutes.post(`${PREFIX}/fsrs-states`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);
  if (!isUuid(body.flashcard_id))
    return err(c, "flashcard_id must be a valid UUID", 400);

  const { fields, error: valErr } = validateFields(body, [
    {
      key: "stability",
      check: (v) => isNum(v) && (v as number) > 0,
      msg: "must be a positive number",
    },
    {
      key: "difficulty",
      check: (v) => inRange(v, 0, 10),
      msg: "must be in [0, 10]",
    },
    { key: "due_at", check: isIsoTs, msg: "must be an ISO timestamp" },
    {
      key: "last_review_at",
      check: isIsoTs,
      msg: "must be an ISO timestamp",
    },
    { key: "reps", check: isNonNegInt, msg: "must be a non-negative integer" },
    {
      key: "lapses",
      check: isNonNegInt,
      msg: "must be a non-negative integer",
    },
    {
      key: "state",
      check: (v) => isOneOf(v, FSRS_STATES),
      msg: `must be one of: ${FSRS_STATES.join(", ")}`,
    },
  ]);
  if (valErr) return err(c, valErr, 400);

  const row = {
    student_id: user.id,
    flashcard_id: body.flashcard_id,
    ...fields,
  };
  const { data, error } = await atomicUpsert(
    db,
    "fsrs_states",
    "student_id,flashcard_id",
    row,
  );

  if (error)
    return err(c, `Upsert fsrs_state failed: ${error.message}`, 500);
  return ok(c, data);
});

// ── 10. BKT States ────────────────────────────────────────────────
// One per student + subtopic. Bayesian Knowledge Tracing parameters.
// UNIQUE(student_id, subtopic_id) required.

studyRoutes.get(`${PREFIX}/bkt-states`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  let query = db
    .from("bkt_states")
    .select("*")
    .eq("student_id", user.id)
    .order("updated_at", { ascending: false });

  const subtopicId = c.req.query("subtopic_id");
  if (subtopicId) {
    if (!isUuid(subtopicId))
      return err(c, "subtopic_id must be a valid UUID", 400);
    query = query.eq("subtopic_id", subtopicId);
  }

  // Pagination
  const limit = parseInt(c.req.query("limit") ?? "100", 10);
  const offset = parseInt(c.req.query("offset") ?? "0", 10);
  query = query.range(offset, offset + limit - 1);

  const { data, error } = await query;
  if (error)
    return err(c, `List bkt_states failed: ${error.message}`, 500);
  return ok(c, data);
});

studyRoutes.post(`${PREFIX}/bkt-states`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);
  if (!isUuid(body.subtopic_id))
    return err(c, "subtopic_id must be a valid UUID", 400);

  const { fields, error: valErr } = validateFields(body, [
    { key: "p_know", check: isProbability, msg: "must be in [0, 1]" },
    { key: "p_transit", check: isProbability, msg: "must be in [0, 1]" },
    { key: "p_slip", check: isProbability, msg: "must be in [0, 1]" },
    { key: "p_guess", check: isProbability, msg: "must be in [0, 1]" },
    { key: "delta", check: isNum, msg: "must be a finite number" },
    {
      key: "total_attempts",
      check: isNonNegInt,
      msg: "must be a non-negative integer",
    },
    {
      key: "correct_attempts",
      check: isNonNegInt,
      msg: "must be a non-negative integer",
    },
    {
      key: "last_attempt_at",
      check: isIsoTs,
      msg: "must be an ISO timestamp",
    },
  ]);
  if (valErr) return err(c, valErr, 400);

  const row = {
    student_id: user.id,
    subtopic_id: body.subtopic_id,
    ...fields,
  };
  const { data, error } = await atomicUpsert(
    db,
    "bkt_states",
    "student_id,subtopic_id",
    row,
  );

  if (error)
    return err(c, `Upsert bkt_state failed: ${error.message}`, 500);
  return ok(c, data);
});

export { studyRoutes };

/**
 * routes-study.tsx — Study sessions, progress & spaced repetition for Axon v4.4
 *
 * O-3 FIX: Reviews GET/POST verify session ownership via study_sessions.student_id.
 * P-2 FIX: Pagination caps added to daily-activities, fsrs-states, bkt-states.
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

const MAX_PAGINATION_LIMIT = 500;

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

/**
 * O-3 FIX: Verify that a study_session belongs to the authenticated user.
 * Called before any reviews operation to prevent cross-user access.
 * Returns null if the session exists and belongs to the user, or an error Response.
 */
async function verifySessionOwnership(
  c: Context,
  db: SupabaseClient,
  sessionId: string,
  userId: string,
): Promise<Response | null> {
  const { data: session, error: sessionErr } = await db
    .from("study_sessions")
    .select("id")
    .eq("id", sessionId)
    .eq("student_id", userId)
    .maybeSingle();

  if (sessionErr) {
    return err(c, `Session lookup failed: ${sessionErr.message}`, 500);
  }
  if (!session) {
    return err(c, "Session not found or does not belong to you", 404);
  }
  return null;
}

// ═════════════════════════════════════════════════════════════════════
// UNIFIED ENDPOINT: topic-progress (N+1 → 1 request)
//
// GET /topic-progress?topic_id=xxx
//
// Returns all summaries for a topic, enriched with:
//   - reading_state (per student, from reading_states table)
//   - flashcard_count (active flashcards per summary)
//
// This replaces the N+1 pattern where the frontend did:
//   1 request  → GET /summaries?topic_id=xxx
//   N requests → GET /reading-states?summary_id=yyy  (per summary)
//   N requests → GET /flashcards?summary_id=yyy      (per summary)
//   Total: 1 + 2N requests (up to 21 for 10 summaries)
//
// Now: 1 request → GET /topic-progress?topic_id=xxx
//   Server does 3 parallel queries internally.
// ═════════════════════════════════════════════════════════════════════

studyRoutes.get(`${PREFIX}/topic-progress`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const topicId = c.req.query("topic_id");
  if (!isUuid(topicId)) {
    return err(c, "topic_id must be a valid UUID", 400);
  }

  try {
    // Step 1: Get published summaries for this topic
    const { data: summaries, error: sumErr } = await db
      .from("summaries")
      .select("*")
      .eq("topic_id", topicId)
      .eq("status", "published")
      .eq("is_active", true)
      .is("deleted_at", null)
      .order("order_index", { ascending: true });

    if (sumErr) {
      return err(c, `Failed to fetch summaries: ${sumErr.message}`, 500);
    }

    if (!summaries || summaries.length === 0) {
      return ok(c, { summaries: [], reading_states: {}, flashcard_counts: {} });
    }

    const summaryIds = summaries.map((s: any) => s.id);

    // Step 2: Batch fetch reading states + flashcard counts in parallel
    const [readingStatesResult, flashcardsResult] = await Promise.all([
      // Batch reading states: WHERE student_id = user AND summary_id IN (...)
      db
        .from("reading_states")
        .select("*")
        .eq("student_id", user.id)
        .in("summary_id", summaryIds),

      // Batch flashcard counts: WHERE summary_id IN (...) AND is_active AND NOT deleted
      // We only need the count per summary, so select minimal columns
      db
        .from("flashcards")
        .select("id, summary_id")
        .in("summary_id", summaryIds)
        .eq("is_active", true)
        .is("deleted_at", null),
    ]);

    // Process reading states into a map: { summary_id: ReadingState }
    const readingStatesMap: Record<string, unknown> = {};
    if (!readingStatesResult.error && readingStatesResult.data) {
      for (const rs of readingStatesResult.data) {
        readingStatesMap[rs.summary_id] = rs;
      }
    }

    // Process flashcard counts into a map: { summary_id: count }
    const flashcardCountsMap: Record<string, number> = {};
    if (!flashcardsResult.error && flashcardsResult.data) {
      for (const fc of flashcardsResult.data) {
        flashcardCountsMap[fc.summary_id] =
          (flashcardCountsMap[fc.summary_id] || 0) + 1;
      }
    }

    return ok(c, {
      summaries,
      reading_states: readingStatesMap,
      flashcard_counts: flashcardCountsMap,
    });
  } catch (e: any) {
    return err(c, `topic-progress failed: ${e.message}`, 500);
  }
});

// ═════════════════════════════════════════════════════════════════════
// UNIFIED ENDPOINT: topics-overview (section N+1 → 1 request)
//
// GET /topics-overview?topic_ids=uuid1,uuid2,uuid3,...
//
// Batch endpoint for SectionStudyPlanView: returns summaries grouped
// by topic + keyword counts per topic, all in 1 HTTP call.
//
// Replaces the N+1 pattern where the frontend did:
//   T requests → GET /summaries?topic_id=xxx  (per topic)
//   T×S requests → GET /keywords?summary_id=yyy (per summary)
//   Total: T + (T×S) requests (e.g. 30 for 5 topics × 5 summaries)
//
// Now: 1 request → GET /topics-overview?topic_ids=uuid1,uuid2,...
//   Server does 2 parallel queries internally.
//
// Max 50 topic_ids per call (safety cap).
// ═════════════════════════════════════════════════════════════════════

const MAX_TOPIC_IDS = 50;

studyRoutes.get(`${PREFIX}/topics-overview`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const topicIdsRaw = c.req.query("topic_ids");
  if (!topicIdsRaw || topicIdsRaw.trim() === "") {
    return err(c, "topic_ids query param is required (comma-separated UUIDs)", 400);
  }

  // Parse and validate each UUID
  const topicIds = topicIdsRaw.split(",").map((id) => id.trim()).filter(Boolean);
  if (topicIds.length === 0) {
    return err(c, "topic_ids must contain at least one UUID", 400);
  }
  if (topicIds.length > MAX_TOPIC_IDS) {
    return err(c, `topic_ids cannot exceed ${MAX_TOPIC_IDS} items`, 400);
  }
  for (const id of topicIds) {
    if (!isUuid(id)) {
      return err(c, `Invalid UUID in topic_ids: ${id}`, 400);
    }
  }

  try {
    // Step 1: Get all active summaries for all requested topics
    const { data: allSummaries, error: sumErr } = await db
      .from("summaries")
      .select("*")
      .in("topic_id", topicIds)
      .eq("is_active", true)
      .is("deleted_at", null)
      .order("order_index", { ascending: true });

    if (sumErr) {
      return err(c, `Failed to fetch summaries: ${sumErr.message}`, 500);
    }

    // Group summaries by topic_id
    const summariesByTopic: Record<string, unknown[]> = {};
    for (const tid of topicIds) {
      summariesByTopic[tid] = [];
    }

    const allSummaryIds: string[] = [];
    if (allSummaries) {
      for (const s of allSummaries) {
        if (!summariesByTopic[s.topic_id]) {
          summariesByTopic[s.topic_id] = [];
        }
        summariesByTopic[s.topic_id].push(s);
        allSummaryIds.push(s.id);
      }
    }

    // Step 2: If there are summaries, batch-fetch keyword counts
    const keywordCountsByTopic: Record<string, number> = {};
    for (const tid of topicIds) {
      keywordCountsByTopic[tid] = 0;
    }

    if (allSummaryIds.length > 0) {
      const { data: keywords, error: kwErr } = await db
        .from("keywords")
        .select("id, summary_id")
        .in("summary_id", allSummaryIds)
        .eq("is_active", true)
        .is("deleted_at", null);

      if (!kwErr && keywords) {
        // Build summary_id → topic_id lookup
        const summaryToTopic: Record<string, string> = {};
        if (allSummaries) {
          for (const s of allSummaries) {
            summaryToTopic[s.id] = s.topic_id;
          }
        }

        // Count keywords per topic
        for (const kw of keywords) {
          const topicId = summaryToTopic[kw.summary_id];
          if (topicId) {
            keywordCountsByTopic[topicId] =
              (keywordCountsByTopic[topicId] || 0) + 1;
          }
        }
      }
    }

    return ok(c, {
      summaries_by_topic: summariesByTopic,
      keyword_counts_by_topic: keywordCountsByTopic,
    });
  } catch (e: any) {
    return err(c, `topics-overview failed: ${e.message}`, 500);
  }
});

// ═════════════════════════════════════════════════════════════════════
// FACTORY TABLES
// ═════════════════════════════════════════════════════════════════════

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
  updateFields: ["completed_at", "total_reviews", "correct_reviews"],
});

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
// O-3 FIX: Both GET and POST verify session belongs to the user.

studyRoutes.get(`${PREFIX}/reviews`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const sessionId = c.req.query("session_id");
  if (!isUuid(sessionId)) {
    return err(c, "session_id must be a valid UUID", 400);
  }

  // O-3 FIX: Verify session belongs to user
  const ownershipErr = await verifySessionOwnership(c, db, sessionId, user.id);
  if (ownershipErr) return ownershipErr;

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
  const { user, db } = auth;

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

  // O-3 FIX: Verify session belongs to user
  const ownershipErr = await verifySessionOwnership(
    c, db, body.session_id as string, user.id,
  );
  if (ownershipErr) return ownershipErr;

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

studyRoutes.get(`${PREFIX}/quiz-attempts`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const questionId = c.req.query("quiz_question_id");
  const sessionId = c.req.query("session_id");

  if (!questionId && !sessionId) {
    return err(c, "At least one filter required: quiz_question_id or session_id", 400);
  }

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

studyRoutes.get(`${PREFIX}/reading-states`, async (c: Context) => {
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
  const { data, error } = await atomicUpsert(db, "reading_states", "student_id,summary_id", row);
  if (error) return err(c, `Upsert reading_state failed: ${error.message}`, 500);
  return ok(c, data);
});

studyRoutes.get(`${PREFIX}/daily-activities`, async (c: Context) => {
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

  const row = { student_id: user.id, activity_date: body.activity_date, ...fields };
  const { data, error } = await atomicUpsert(db, "daily_activities", "student_id,activity_date", row);
  if (error) return err(c, `Upsert daily_activity failed: ${error.message}`, 500);
  return ok(c, data);
});

studyRoutes.get(`${PREFIX}/student-stats`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const { data, error } = await db.from("student_stats").select("*")
    .eq("student_id", user.id).maybeSingle();
  if (error) return err(c, `Get student_stats failed: ${error.message}`, 500);
  return ok(c, data);
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
  const { data, error } = await atomicUpsert(db, "student_stats", "student_id", row);
  if (error) return err(c, `Upsert student_stats failed: ${error.message}`, 500);
  return ok(c, data);
});

const FSRS_STATES = ["new", "learning", "review", "relearning"] as const;

studyRoutes.get(`${PREFIX}/fsrs-states`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  let query = db.from("fsrs_states").select("*").eq("student_id", user.id)
    .order("due_at", { ascending: true });

  const flashcardId = c.req.query("flashcard_id");
  const state = c.req.query("state");
  const dueBefore = c.req.query("due_before");

  if (flashcardId) {
    if (!isUuid(flashcardId)) return err(c, "flashcard_id must be a valid UUID", 400);
    query = query.eq("flashcard_id", flashcardId);
  }
  if (state) {
    if (!isOneOf(state, FSRS_STATES))
      return err(c, `state must be one of: ${FSRS_STATES.join(", ")}`, 400);
    query = query.eq("state", state);
  }
  if (dueBefore) {
    if (!isIsoTs(dueBefore)) return err(c, "due_before must be an ISO timestamp", 400);
    query = query.lte("due_at", dueBefore);
  }

  let limit = parseInt(c.req.query("limit") ?? "100", 10);
  if (isNaN(limit) || limit < 1) limit = 100;
  if (limit > MAX_PAGINATION_LIMIT) limit = MAX_PAGINATION_LIMIT;
  let offset = parseInt(c.req.query("offset") ?? "0", 10);
  if (isNaN(offset) || offset < 0) offset = 0;
  query = query.range(offset, offset + limit - 1);

  const { data, error } = await query;
  if (error) return err(c, `List fsrs_states failed: ${error.message}`, 500);
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
    { key: "stability", check: (v) => isNum(v) && (v as number) > 0, msg: "must be a positive number" },
    { key: "difficulty", check: (v) => inRange(v, 0, 10), msg: "must be in [0, 10]" },
    { key: "due_at", check: isIsoTs, msg: "must be an ISO timestamp" },
    { key: "last_review_at", check: isIsoTs, msg: "must be an ISO timestamp" },
    { key: "reps", check: isNonNegInt, msg: "must be a non-negative integer" },
    { key: "lapses", check: isNonNegInt, msg: "must be a non-negative integer" },
    { key: "state", check: (v) => isOneOf(v, FSRS_STATES), msg: `must be one of: ${FSRS_STATES.join(", ")}` },
  ]);
  if (valErr) return err(c, valErr, 400);

  const row = { student_id: user.id, flashcard_id: body.flashcard_id, ...fields };
  const { data, error } = await atomicUpsert(db, "fsrs_states", "student_id,flashcard_id", row);
  if (error) return err(c, `Upsert fsrs_state failed: ${error.message}`, 500);
  return ok(c, data);
});

studyRoutes.get(`${PREFIX}/bkt-states`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  let query = db.from("bkt_states").select("*").eq("student_id", user.id)
    .order("updated_at", { ascending: false });

  const subtopicId = c.req.query("subtopic_id");
  if (subtopicId) {
    if (!isUuid(subtopicId)) return err(c, "subtopic_id must be a valid UUID", 400);
    query = query.eq("subtopic_id", subtopicId);
  }

  let limit = parseInt(c.req.query("limit") ?? "100", 10);
  if (isNaN(limit) || limit < 1) limit = 100;
  if (limit > MAX_PAGINATION_LIMIT) limit = MAX_PAGINATION_LIMIT;
  let offset = parseInt(c.req.query("offset") ?? "0", 10);
  if (isNaN(offset) || offset < 0) offset = 0;
  query = query.range(offset, offset + limit - 1);

  const { data, error } = await query;
  if (error) return err(c, `List bkt_states failed: ${error.message}`, 500);
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
    { key: "total_attempts", check: isNonNegInt, msg: "must be a non-negative integer" },
    { key: "correct_attempts", check: isNonNegInt, msg: "must be a non-negative integer" },
    { key: "last_attempt_at", check: isIsoTs, msg: "must be an ISO timestamp" },
  ]);
  if (valErr) return err(c, valErr, 400);

  const row = { student_id: user.id, subtopic_id: body.subtopic_id, ...fields };
  const { data, error } = await atomicUpsert(db, "bkt_states", "student_id,subtopic_id", row);
  if (error) return err(c, `Upsert bkt_state failed: ${error.message}`, 500);
  return ok(c, data);
});

export { studyRoutes };

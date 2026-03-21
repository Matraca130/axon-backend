/**
 * routes/study/progress.ts — Student progress tracking
 *
 * UNIFIED ENDPOINTS (speed optimizations):
 *   GET /topic-progress?topic_id=xxx — summaries + reading states + flashcard counts in 1 request
 *   GET /topics-overview?topic_ids=a,b,c — summaries by topic + keyword counts (batch, max 50)
 *
 * UPSERT TABLES — atomic .upsert({ onConflict }):
 *   reading_states    — per-summary reading progress
 *   daily_activities  — per-day activity log
 *   student_stats     — aggregated stats per student
 *
 * P-2 FIX: Pagination caps added to daily-activities.
 * F3 FIX: topics-overview now filters by status = 'published'
 *         (consistency with topic-progress which already did).
 * GAMIFICATION: Sprint 1 — xpHookForReadingComplete wired to POST /reading-states.
 */

import { Hono } from "npm:hono";
import type { SupabaseClient } from "npm:@supabase/supabase-js";
import { authenticate, ok, err, safeJson, PREFIX } from "../../db.ts";
import { safeErr } from "../../lib/safe-error.ts";
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
import { xpHookForReadingComplete } from "../../xp-hooks.ts";

export const progressRoutes = new Hono();

const MAX_PAGINATION_LIMIT = 500;
const MAX_TOPIC_IDS = 50;

// ─── Shared Helper ──────────────────────────────────────────────────────

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

// ═════════════════════════════════════════════════════════════════
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
// ═════════════════════════════════════════════════════════════════

progressRoutes.get(`${PREFIX}/topic-progress`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const topicId = c.req.query("topic_id");
  if (!isUuid(topicId)) {
    return err(c, "topic_id must be a valid UUID", 400);
  }

  try {
    // Step 1: Get published summaries for this topic
    // Explicit columns: excludes content_markdown (tens of KB) and embedding (6 KB)
    const { data: summaries, error: sumErr } = await db
      .from("summaries")
      .select("id, topic_id, title, status, order_index, is_active, created_by, created_at, updated_at, deleted_at")
      .eq("topic_id", topicId)
      .eq("status", "published")
      .eq("is_active", true)
      .is("deleted_at", null)
      .order("order_index", { ascending: true });

    if (sumErr) {
      return safeErr(c, "Fetch summaries", sumErr);
    }

    if (!summaries || summaries.length === 0) {
      return ok(c, { summaries: [], reading_states: {}, flashcard_counts: {} });
    }

    const summaryIds = summaries.map((s: any) => s.id);

    // Step 2: Batch fetch reading states + flashcard counts in parallel
    const [readingStatesResult, flashcardsResult] = await Promise.all([
      db
        .from("reading_states")
        .select("id, student_id, summary_id, scroll_position, time_spent_seconds, completed, last_read_at, created_at, updated_at")
        .eq("student_id", user.id)
        .in("summary_id", summaryIds),

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
    return safeErr(c, "Topic progress", e);
  }
});

// ═════════════════════════════════════════════════════════════════
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
// F3 FIX: Now filters by status = 'published' for consistency
// with topic-progress endpoint (which already did this).
//
// Max 50 topic_ids per call (safety cap).
// ═════════════════════════════════════════════════════════════════

progressRoutes.get(`${PREFIX}/topics-overview`, async (c: Context) => {
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
    // Step 1: Get all published, active summaries for all requested topics
    // F3 FIX: Added .eq("status", "published") for consistency with topic-progress
    // Explicit columns: excludes content_markdown (tens of KB) and embedding (6 KB)
    const { data: allSummaries, error: sumErr } = await db
      .from("summaries")
      .select("id, topic_id, title, status, order_index, is_active, created_by, created_at, updated_at, deleted_at")
      .in("topic_id", topicIds)
      .eq("status", "published")
      .eq("is_active", true)
      .is("deleted_at", null)
      .order("order_index", { ascending: true });

    if (sumErr) {
      return safeErr(c, "Fetch summaries", sumErr);
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
    return safeErr(c, "Topics overview", e);
  }
});

// ─── Reading States ─────────────────────────────────────────────────────

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

  if (error) return safeErr(c, "Get reading_state", error);
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
    { key: "scroll_position", check: isNonNeg, msg: "must be >= 0" },
    { key: "time_spent_seconds", check: isNonNeg, msg: "must be >= 0" },
    { key: "completed", check: isBool, msg: "must be a boolean" },
    { key: "last_read_at", check: isIsoTs, msg: "must be an ISO timestamp" },
  ]);
  if (valErr) return err(c, valErr, 400);

  const row = { student_id: user.id, summary_id: body.summary_id, ...fields };
  const { data, error } = await atomicUpsert(db, "reading_states", "student_id,summary_id", row);
  if (error) return safeErr(c, "Upsert reading_state", error);

  // Sprint 1: Fire-and-forget XP hook when reading is marked complete (contract §4.3)
  // Only triggers when completed=true is in the request body.
  // The hook internally checks action === "update" && updatedFields.includes("completed").
  if (body.completed === true) {
    try {
      xpHookForReadingComplete({
        action: "update",
        row: data as Record<string, unknown>,
        updatedFields: Object.keys(fields),
        userId: user.id,
      });
    } catch (hookErr) {
      console.warn("[XP Hook] reading-state setup error:", (hookErr as Error).message);
    }
  }

  return ok(c, data);
});

// ─── Daily Activities ──────────────────────────────────────────────────

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
  if (error) return safeErr(c, "List daily_activities", error);
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
    { key: "time_spent_seconds", check: isNonNeg, msg: "must be >= 0" },
    { key: "sessions_count", check: isNonNegInt, msg: "must be a non-negative integer" },
  ]);
  if (valErr) return err(c, valErr, 400);

  const row = { student_id: user.id, activity_date: body.activity_date, ...fields };
  const { data, error } = await atomicUpsert(db, "daily_activities", "student_id,activity_date", row);
  if (error) return safeErr(c, "Upsert daily_activity", error);
  return ok(c, data);
});

// ─── Student Stats ──────────────────────────────────────────────────────

progressRoutes.get(`${PREFIX}/student-stats`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const { data, error } = await db.from("student_stats").select("*")
    .eq("student_id", user.id).maybeSingle();
  if (error) return safeErr(c, "Get student_stats", error);
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
    { key: "total_time_seconds", check: isNonNeg, msg: "must be >= 0" },
    { key: "total_sessions", check: isNonNegInt, msg: "must be a non-negative integer" },
    { key: "last_study_date", check: isDateOnly, msg: "must be YYYY-MM-DD format" },
  ]);
  if (valErr) return err(c, valErr, 400);

  const row = { student_id: user.id, ...fields };
  const { data, error } = await atomicUpsert(db, "student_stats", "student_id", row);
  if (error) return safeErr(c, "Upsert student_stats", error);
  return ok(c, data);
});

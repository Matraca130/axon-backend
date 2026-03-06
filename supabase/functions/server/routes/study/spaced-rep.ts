/**
 * routes/study/spaced-rep.ts — Spaced repetition state management
 *
 * UPSERT TABLES:
 *   fsrs_states — Free Spaced Repetition Scheduler (card-level)
 *   bkt_states  — Bayesian Knowledge Tracing (subtopic-level)
 *
 * P-2 FIX: Pagination caps added.
 * M-1 FIX: BKT total_attempts/correct_attempts now INCREMENT instead of replace.
 * M-5 FIX: Added subtopic_ids (plural) batch filter to GET /bkt-states.
 */

import { Hono } from "npm:hono";
import { authenticate, ok, err, safeJson, PREFIX } from "../../db.ts";
import {
  isUuid,
  isNum,
  isNonNeg,
  isNonNegInt,
  isIsoTs,
  isProbability,
  inRange,
  isOneOf,
  validateFields,
} from "../../validate.ts";
import { atomicUpsert } from "./progress.ts";
import type { Context } from "npm:hono";

export const spacedRepRoutes = new Hono();

const MAX_PAGINATION_LIMIT = 500;
const MAX_BATCH_SUBTOPIC_IDS = 200;
const FSRS_STATES = ["new", "learning", "review", "relearning"] as const;

// ─── FSRS States ───────────────────────────────────────────────────────

spacedRepRoutes.get(`${PREFIX}/fsrs-states`, async (c: Context) => {
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

spacedRepRoutes.post(`${PREFIX}/fsrs-states`, async (c: Context) => {
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

// ─── BKT States ────────────────────────────────────────────────────────

spacedRepRoutes.get(`${PREFIX}/bkt-states`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  let query = db.from("bkt_states").select("*").eq("student_id", user.id)
    .order("updated_at", { ascending: false });

  const subtopicId = c.req.query("subtopic_id");
  const subtopicIds = c.req.query("subtopic_ids");

  // M-5 FIX: subtopic_id (singular) and subtopic_ids (plural) are mutually
  // exclusive. Using both would create ambiguous query semantics.
  if (subtopicId && subtopicIds) {
    return err(c, "Cannot use both subtopic_id and subtopic_ids — pick one", 400);
  }

  if (subtopicId) {
    if (!isUuid(subtopicId)) return err(c, "subtopic_id must be a valid UUID", 400);
    query = query.eq("subtopic_id", subtopicId);
  }

  // M-5 FIX: Batch filter by multiple subtopic IDs (comma-separated).
  // Replaces the global ?limit=500 workaround with precise scoped fetch.
  // Frontend sends subtopic_ids derived from the subtopics-batch response
  // for the current summary, reducing data transfer from "all student BKT
  // states ever" to "only BKT states for this summary's subtopics".
  if (subtopicIds) {
    const ids = subtopicIds.split(",").map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) {
      return err(c, "subtopic_ids must contain at least one UUID", 400);
    }
    if (ids.length > MAX_BATCH_SUBTOPIC_IDS) {
      return err(
        c,
        `subtopic_ids cannot exceed ${MAX_BATCH_SUBTOPIC_IDS} (got ${ids.length})`,
        400,
      );
    }
    for (const id of ids) {
      if (!isUuid(id)) {
        return err(c, `Invalid UUID in subtopic_ids: ${id}`, 400);
      }
    }
    query = query.in("subtopic_id", ids);
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

spacedRepRoutes.post(`${PREFIX}/bkt-states`, async (c: Context) => {
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

  // ── M-1 FIX: INCREMENT counters instead of replacing ──────────────
  // Frontend sends delta values (e.g. total_attempts=1, correct_attempts=0|1).
  // We read the existing row and add the deltas to get cumulative totals.
  // This fixes the bug where 50 reviews still showed total_attempts=1.
  //
  // Race condition risk: minimal — a single student reviewing the same
  // subtopic within milliseconds is practically impossible.
  if (
    fields.total_attempts !== undefined ||
    fields.correct_attempts !== undefined
  ) {
    const { data: existing } = await db
      .from("bkt_states")
      .select("total_attempts, correct_attempts")
      .eq("student_id", user.id)
      .eq("subtopic_id", body.subtopic_id)
      .maybeSingle();

    if (existing) {
      if (fields.total_attempts !== undefined) {
        fields.total_attempts =
          (existing.total_attempts || 0) + (fields.total_attempts as number);
      }
      if (fields.correct_attempts !== undefined) {
        fields.correct_attempts =
          (existing.correct_attempts || 0) +
          (fields.correct_attempts as number);
      }
    }
    // If no existing row, the delta IS the initial value (correct).
  }

  const row = { student_id: user.id, subtopic_id: body.subtopic_id, ...fields };
  const { data, error } = await atomicUpsert(db, "bkt_states", "student_id,subtopic_id", row);
  if (error) return err(c, `Upsert bkt_state failed: ${error.message}`, 500);
  return ok(c, data);
});

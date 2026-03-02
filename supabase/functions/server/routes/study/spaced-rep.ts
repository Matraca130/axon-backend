/**
 * routes/study/spaced-rep.ts — Spaced repetition state management
 *
 * UPSERT TABLES:
 *   fsrs_states — Free Spaced Repetition Scheduler (card-level)
 *   bkt_states  — Bayesian Knowledge Tracing (subtopic-level)
 *
 * P-2 FIX: Pagination caps added.
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
const FSRS_STATES = ["new", "learning", "review", "relearning"] as const;

// ─── FSRS States ─────────────────────────────────────────────────────

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

// ─── BKT States ──────────────────────────────────────────────────────

spacedRepRoutes.get(`${PREFIX}/bkt-states`, async (c: Context) => {
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

  const row = { student_id: user.id, subtopic_id: body.subtopic_id, ...fields };
  const { data, error } = await atomicUpsert(db, "bkt_states", "student_id,subtopic_id", row);
  if (error) return err(c, `Upsert bkt_state failed: ${error.message}`, 500);
  return ok(c, data);
});

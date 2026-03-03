/**
 * routes/study/reviews.ts — Reviews & quiz attempts
 *
 * CREATE-ONLY TABLES (LIST + POST — no update, no delete):
 *   reviews       — O-3 FIX: session ownership verification
 *   quiz_attempts — student quiz answers
 */

import { Hono } from "npm:hono";
import type { SupabaseClient } from "npm:@supabase/supabase-js";
import { authenticate, ok, err, safeJson, PREFIX } from "../../db.ts";
import {
  isUuid,
  isNonEmpty,
  isBool,
  isNonNegInt,
  inRange,
} from "../../validate.ts";
import type { Context } from "npm:hono";

export const reviewRoutes = new Hono();

// ─── Helper ─────────────────────────────────────────────────────────────

/**
 * O-3 FIX: Verify that a study_session belongs to the authenticated user.
 * Called before any reviews operation to prevent cross-user access.
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

// ─── Reviews ───────────────────────────────────────────────────────────

reviewRoutes.get(`${PREFIX}/reviews`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const sessionId = c.req.query("session_id");
  if (!isUuid(sessionId)) {
    return err(c, "session_id must be a valid UUID", 400);
  }

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

reviewRoutes.post(`${PREFIX}/reviews`, async (c: Context) => {
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

// ─── Quiz Attempts ─────────────────────────────────────────────────────

reviewRoutes.get(`${PREFIX}/quiz-attempts`, async (c: Context) => {
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

reviewRoutes.post(`${PREFIX}/quiz-attempts`, async (c: Context) => {
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

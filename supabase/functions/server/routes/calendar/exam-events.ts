/**
 * routes/calendar/exam-events.ts — CRUD for exam events
 *
 * POST   /calendar/exam-events       — create exam event
 * PATCH  /calendar/exam-events/:id   — update exam event
 * DELETE /calendar/exam-events/:id   — delete exam event
 *
 * All routes require authentication. student_id is always derived from
 * the JWT (never from the request body). Ownership is verified on
 * update and delete.
 *
 * Sprint 1 Fix — CRITICAL
 * FILE: supabase/functions/server/routes/calendar/exam-events.ts
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, safeJson, PREFIX } from "../../db.ts";
import {
  isUuid,
  isNonEmpty,
  isBool,
  isStr,
  isDateOnly,
  validateFields,
} from "../../validate.ts";

export const examEventRoutes = new Hono();

// ─── Columns returned by SELECT (FIX 4 — explicit select) ──────
const EXAM_EVENT_COLUMNS =
  "id, student_id, course_id, institution_id, title, date, time, location, is_final, exam_type, created_at, updated_at";

// ─── POST /calendar/exam-events ─────────────────────────────────

examEventRoutes.post(`${PREFIX}/calendar/exam-events`, async (c: Context) => {
  // Auth
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  // Parse body
  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  // Validate required fields
  const { fields, error: valErr } = validateFields(body, [
    { key: "title", check: isNonEmpty, msg: "must be a non-empty string", required: true },
    { key: "date", check: isDateOnly, msg: "must be YYYY-MM-DD", required: true },
    { key: "time", check: isStr, msg: "must be a string" },
    { key: "location", check: isStr, msg: "must be a string" },
    { key: "course_id", check: isUuid, msg: "must be a valid UUID", required: true },
    { key: "is_final", check: isBool, msg: "must be a boolean" },
    { key: "exam_type", check: isStr, msg: "must be a string" },
  ]);
  if (valErr) return err(c, valErr, 400);

  const courseId = fields.course_id as string;

  // Verify the student is enrolled in the course
  const { data: enrollment, error: enrollErr } = await db
    .from("course_enrollments")
    .select("id")
    .eq("course_id", courseId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (enrollErr) {
    console.error(`[exam-events] enrollment lookup error: ${enrollErr.message}`);
    return err(c, "Failed to verify course enrollment", 500);
  }
  if (!enrollment) {
    return err(c, "You are not enrolled in this course", 403);
  }

  // Lookup institution_id from the course
  const { data: course, error: courseErr } = await db
    .from("courses")
    .select("institution_id")
    .eq("id", courseId)
    .maybeSingle();

  if (courseErr) {
    console.error(`[exam-events] course lookup error: ${courseErr.message}`);
    return err(c, "Failed to lookup course", 500);
  }
  if (!course) {
    return err(c, "Course not found", 404);
  }

  // Insert with field allowlisting (never spread raw body)
  const { data, error: insertErr } = await db
    .from("exam_events")
    .insert({
      student_id: user.id,
      course_id: courseId,
      institution_id: course.institution_id,
      title: fields.title,
      date: fields.date,
      ...(fields.time !== undefined && { time: fields.time }),
      ...(fields.location !== undefined && { location: fields.location }),
      ...(fields.is_final !== undefined && { is_final: fields.is_final }),
      ...(fields.exam_type !== undefined && { exam_type: fields.exam_type }),
    })
    .select(EXAM_EVENT_COLUMNS)
    .single();

  if (insertErr) {
    console.error(`[exam-events] insert error: ${insertErr.message}`);
    return err(c, "Failed to create exam event", 500);
  }

  return ok(c, data, 201);
});

// ─── PATCH /calendar/exam-events/:id ────────────────────────────

examEventRoutes.patch(`${PREFIX}/calendar/exam-events/:id`, async (c: Context) => {
  // Auth
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const eventId = c.req.param("id");
  if (!isUuid(eventId)) return err(c, "Invalid event ID", 400);

  // Verify ownership
  const { data: existing, error: lookupErr } = await db
    .from("exam_events")
    .select("student_id")
    .eq("id", eventId)
    .maybeSingle();

  if (lookupErr) {
    console.error(`[exam-events] lookup error: ${lookupErr.message}`);
    return err(c, "Failed to lookup exam event", 500);
  }
  if (!existing) return err(c, "Exam event not found", 404);
  if (existing.student_id !== user.id) return err(c, "Not authorized", 403);

  // Parse body
  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  // Only allow updating these fields (NO student_id, course_id, institution_id)
  const { fields, error: valErr } = validateFields(body, [
    { key: "title", check: isNonEmpty, msg: "must be a non-empty string" },
    { key: "date", check: isDateOnly, msg: "must be YYYY-MM-DD" },
    { key: "time", check: isStr, msg: "must be a string" },
    { key: "location", check: isStr, msg: "must be a string" },
    { key: "is_final", check: isBool, msg: "must be a boolean" },
    { key: "exam_type", check: isStr, msg: "must be a string" },
  ]);
  if (valErr) return err(c, valErr, 400);

  if (Object.keys(fields).length === 0) {
    return err(c, "No valid fields to update", 400);
  }

  const { data, error: updateErr } = await db
    .from("exam_events")
    .update(fields)
    .eq("id", eventId)
    .select(EXAM_EVENT_COLUMNS)
    .single();

  if (updateErr) {
    console.error(`[exam-events] update error: ${updateErr.message}`);
    return err(c, "Failed to update exam event", 500);
  }

  return ok(c, data, 200);
});

// ─── DELETE /calendar/exam-events/:id ───────────────────────────

examEventRoutes.delete(`${PREFIX}/calendar/exam-events/:id`, async (c: Context) => {
  // Auth
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const eventId = c.req.param("id");
  if (!isUuid(eventId)) return err(c, "Invalid event ID", 400);

  // Verify ownership
  const { data: existing, error: lookupErr } = await db
    .from("exam_events")
    .select("student_id")
    .eq("id", eventId)
    .maybeSingle();

  if (lookupErr) {
    console.error(`[exam-events] lookup error: ${lookupErr.message}`);
    return err(c, "Failed to lookup exam event", 500);
  }
  if (!existing) return err(c, "Exam event not found", 404);
  if (existing.student_id !== user.id) return err(c, "Not authorized", 403);

  const { error: deleteErr } = await db
    .from("exam_events")
    .delete()
    .eq("id", eventId);

  if (deleteErr) {
    console.error(`[exam-events] delete error: ${deleteErr.message}`);
    return err(c, "Failed to delete exam event", 500);
  }

  return ok(c, { deleted: true }, 200);
});

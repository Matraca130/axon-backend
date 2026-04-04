/**
 * routes/admin/finals-periods.ts — CRUD for finals periods
 *
 * GET    /admin/finals-periods?institution_id=X   — list finals periods
 * POST   /admin/finals-periods                    — create finals period
 * PATCH  /admin/finals-periods/:id                — update finals period
 * DELETE /admin/finals-periods/:id                — delete finals period
 *
 * Authorization:
 *   - GET: any active member of the institution (ALL_ROLES)
 *   - POST/PATCH/DELETE: professor, admin, or owner (CONTENT_WRITE_ROLES)
 *
 * Phase 1 — Deploy endpoints
 * FILE: supabase/functions/server/routes/admin/finals-periods.ts
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, safeJson, PREFIX } from "../../db.ts";
import { safeErr } from "../../lib/safe-error.ts";
import {
  requireInstitutionRole,
  isDenied,
  ALL_ROLES,
  CONTENT_WRITE_ROLES,
} from "../../auth-helpers.ts";
import { isUuid, isDateOnly, validateFields } from "../../validate.ts";

export const finalsPeriodsRoutes = new Hono();

const COLUMNS = "id, institution_id, course_id, finals_period_start, finals_period_end, created_by, created_at";

// ─── GET /admin/finals-periods ─────────────────────────────────

finalsPeriodsRoutes.get(`${PREFIX}/admin/finals-periods`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const institutionId = c.req.query("institution_id");
  if (!institutionId || !isUuid(institutionId)) {
    return err(c, "institution_id query parameter is required (UUID)", 400);
  }

  // RBAC: any active member can read
  const roleCheck = await requireInstitutionRole(db, user.id, institutionId, ALL_ROLES);
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status);

  // Optional course_id filter
  const courseId = c.req.query("course_id");

  let query = db
    .from("finals_periods")
    .select(COLUMNS)
    .eq("institution_id", institutionId)
    .order("finals_period_start", { ascending: true });

  if (courseId) {
    if (!isUuid(courseId)) return err(c, "course_id must be a valid UUID", 400);
    query = query.eq("course_id", courseId);
  }

  const { data, error: fetchErr } = await query;
  if (fetchErr) return safeErr(c, "List finals periods", fetchErr);

  return ok(c, { items: data ?? [], count: data?.length ?? 0 });
});

// ─── POST /admin/finals-periods ────────────────────────────────

finalsPeriodsRoutes.post(`${PREFIX}/admin/finals-periods`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  // Validate fields
  const { fields, error: valErr } = validateFields(body, [
    { key: "institution_id", check: isUuid, msg: "must be a valid UUID", required: true },
    { key: "course_id", check: isUuid, msg: "must be a valid UUID" },
    { key: "finals_period_start", check: isDateOnly, msg: "must be YYYY-MM-DD", required: true },
    { key: "finals_period_end", check: isDateOnly, msg: "must be YYYY-MM-DD", required: true },
  ]);
  if (valErr) return err(c, valErr, 400);

  const institutionId = fields.institution_id as string;

  // Date validation: end >= start
  if ((fields.finals_period_end as string) < (fields.finals_period_start as string)) {
    return err(c, "finals_period_end must be >= finals_period_start", 400);
  }

  // RBAC: professor, admin, or owner
  const roleCheck = await requireInstitutionRole(db, user.id, institutionId, CONTENT_WRITE_ROLES);
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status);

  const { data, error: insertErr } = await db
    .from("finals_periods")
    .insert({
      institution_id: institutionId,
      ...(fields.course_id !== undefined && { course_id: fields.course_id }),
      finals_period_start: fields.finals_period_start,
      finals_period_end: fields.finals_period_end,
      created_by: user.id,
    })
    .select(COLUMNS)
    .single();

  if (insertErr) return safeErr(c, "Create finals period", insertErr);

  return ok(c, data, 201);
});

// ─── PATCH /admin/finals-periods/:id ───────────────────────────

finalsPeriodsRoutes.patch(`${PREFIX}/admin/finals-periods/:id`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const id = c.req.param("id");
  if (!isUuid(id)) return err(c, "Invalid finals period ID", 400);

  // Lookup existing to get institution_id for RBAC
  const { data: existing, error: lookupErr } = await db
    .from("finals_periods")
    .select("id, institution_id, finals_period_start, finals_period_end")
    .eq("id", id)
    .maybeSingle();

  if (lookupErr) return safeErr(c, "Lookup finals period", lookupErr);
  if (!existing) return err(c, "Finals period not found", 404);

  // RBAC: professor, admin, or owner
  const roleCheck = await requireInstitutionRole(
    db, user.id, existing.institution_id, CONTENT_WRITE_ROLES,
  );
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status);

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const { fields, error: valErr } = validateFields(body, [
    { key: "course_id", check: isUuid, msg: "must be a valid UUID" },
    { key: "finals_period_start", check: isDateOnly, msg: "must be YYYY-MM-DD" },
    { key: "finals_period_end", check: isDateOnly, msg: "must be YYYY-MM-DD" },
  ]);
  if (valErr) return err(c, valErr, 400);

  if (Object.keys(fields).length === 0) {
    return err(c, "No valid fields to update", 400);
  }

  // Date validation: if updating dates, ensure end >= start
  const newStart = (fields.finals_period_start as string) ?? existing.finals_period_start;
  const newEnd = (fields.finals_period_end as string) ?? existing.finals_period_end;
  if (newEnd < newStart) {
    return err(c, "finals_period_end must be >= finals_period_start", 400);
  }

  const { data, error: updateErr } = await db
    .from("finals_periods")
    .update(fields)
    .eq("id", id)
    .select(COLUMNS)
    .single();

  if (updateErr) return safeErr(c, "Update finals period", updateErr);

  return ok(c, data);
});

// ─── DELETE /admin/finals-periods/:id ──────────────────────────

finalsPeriodsRoutes.delete(`${PREFIX}/admin/finals-periods/:id`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const id = c.req.param("id");
  if (!isUuid(id)) return err(c, "Invalid finals period ID", 400);

  // Lookup existing to get institution_id for RBAC
  const { data: existing, error: lookupErr } = await db
    .from("finals_periods")
    .select("id, institution_id")
    .eq("id", id)
    .maybeSingle();

  if (lookupErr) return safeErr(c, "Lookup finals period", lookupErr);
  if (!existing) return err(c, "Finals period not found", 404);

  // RBAC: professor, admin, or owner
  const roleCheck = await requireInstitutionRole(
    db, user.id, existing.institution_id, CONTENT_WRITE_ROLES,
  );
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status);

  const { error: deleteErr } = await db
    .from("finals_periods")
    .delete()
    .eq("id", id);

  if (deleteErr) return safeErr(c, "Delete finals period", deleteErr);

  return ok(c, { deleted: true });
});

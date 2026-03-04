/**
 * routes/members/memberships.ts — Membership CRUD
 *
 * GET    /memberships         — List memberships for an institution
 * GET    /memberships/:id     — Get membership by ID
 * POST   /memberships         — Add member to institution (admin client)
 * PUT    /memberships/:id     — Update membership (role, plan, is_active)
 * DELETE /memberships/:id     — Deactivate membership (soft)
 *
 * U-2 FIX: Pagination added to LIST endpoint.
 *
 * H-3 FIX: POST/PUT/DELETE now verify caller authority:
 *   - POST: requireInstitutionRole(MANAGEMENT_ROLES) + canAssignRole()
 *   - PUT: resolves target institution, verifies caller role, enforces hierarchy
 *   - DELETE: resolves target institution, verifies management role
 *   - GET (list): verifies caller is member of the queried institution
 *   - GET /:id: resolves institution, verifies membership
 */

import { Hono } from "npm:hono";
import { authenticate, getAdminClient, ok, err, safeJson, PREFIX } from "../../db.ts";
import {
  requireInstitutionRole,
  resolveMembershipInstitution,
  isDenied,
  canAssignRole,
  ALL_ROLES,
  MANAGEMENT_ROLES,
} from "../../auth-helpers.ts";
import type { Context } from "npm:hono";

export const membershipRoutes = new Hono();

const memBase = `${PREFIX}/memberships`;

// ─── Constants ────────────────────────────────────────────────────

const MAX_PAGINATION_LIMIT = 500;
const DEFAULT_PAGINATION_LIMIT = 100;
const VALID_ROLES = ["student", "professor", "admin", "owner"];

// ── GET /memberships ─────────────────────────────────────────────
// H-3 FIX: Verify caller is a member of the queried institution.
membershipRoutes.get(memBase, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const institutionId = c.req.query("institution_id");
  if (!institutionId) return err(c, "Missing required query param: institution_id", 400);

  // H-3 FIX: Any active member can list memberships in their institution
  const roleCheck = await requireInstitutionRole(db, user.id, institutionId, ALL_ROLES);
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status);

  // U-2 FIX: Pagination (was returning all rows unbounded)
  let limit = parseInt(c.req.query("limit") ?? String(DEFAULT_PAGINATION_LIMIT), 10);
  if (isNaN(limit) || limit < 1) limit = DEFAULT_PAGINATION_LIMIT;
  if (limit > MAX_PAGINATION_LIMIT) limit = MAX_PAGINATION_LIMIT;
  let offset = parseInt(c.req.query("offset") ?? "0", 10);
  if (isNaN(offset) || offset < 0) offset = 0;

  const { data, count, error } = await db
    .from("memberships").select("*", { count: "estimated" })
    .eq("institution_id", institutionId)
    .order("created_at", { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) return err(c, `List memberships failed: ${error.message}`, 500);
  return ok(c, { items: data, total: count, limit, offset });
});

// ── GET /memberships/:id ─────────────────────────────────────────
// H-3 FIX: Verify caller is a member of the target membership's institution.
membershipRoutes.get(`${memBase}/:id`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const id = c.req.param("id");

  // H-3 FIX: Resolve target membership's institution, verify caller is a member
  const institutionId = await resolveMembershipInstitution(db, id);
  if (!institutionId) return err(c, "Membership not found", 404);

  const roleCheck = await requireInstitutionRole(db, user.id, institutionId, ALL_ROLES);
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status);

  const { data, error } = await db.from("memberships").select("*").eq("id", id).single();
  if (error) return err(c, `Get membership ${id} failed: ${error.message}`, 404);
  return ok(c, data);
});

// ── POST /memberships ────────────────────────────────────────────
// H-3 FIX: Verify caller has management role + enforce role hierarchy.
membershipRoutes.post(memBase, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const { user_id, institution_id, role } = body;
  if (typeof user_id !== "string" || typeof institution_id !== "string")
    return err(c, "user_id and institution_id must be strings", 400);

  if (typeof role !== "string" || !VALID_ROLES.includes(role))
    return err(c, `role must be one of: ${VALID_ROLES.join(", ")}`, 400);

  // H-3 FIX: Verify caller has management role in the target institution
  const roleCheck = await requireInstitutionRole(db, user.id, institution_id, MANAGEMENT_ROLES);
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status);

  // H-3 FIX: Prevent privilege escalation — caller can't assign a role
  // higher than their own. Owner(4) can assign all. Admin(3) can't assign owner.
  if (!canAssignRole(roleCheck.role, role)) {
    return err(
      c,
      `Cannot assign role '${role}' with your current role '${roleCheck.role}'`,
      403,
    );
  }

  // Audit log: track who created the membership and with what authority
  console.log(
    `[Axon Audit] Membership created by ${user.id} (${roleCheck.role}): ` +
    `target_user=${user_id}, institution=${institution_id}, assigned_role=${role}`,
  );

  const admin = getAdminClient();
  const row: Record<string, unknown> = { user_id, institution_id, role };
  if (typeof body.institution_plan_id === "string") row.institution_plan_id = body.institution_plan_id;

  const { data, error } = await admin.from("memberships").insert(row).select().single();
  if (error) return err(c, `Create membership failed: ${error.message}`, error.message.includes("duplicate") ? 409 : 500);
  return ok(c, data, 201);
});

// ── PUT /memberships/:id ─────────────────────────────────────────
// H-3 FIX: Resolve target institution, verify caller authority,
// enforce role hierarchy when changing roles.
membershipRoutes.put(`${memBase}/:id`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const id = c.req.param("id");

  // H-3 FIX: Resolve target membership's institution
  const institutionId = await resolveMembershipInstitution(db, id);
  if (!institutionId) return err(c, "Membership not found", 404);

  const roleCheck = await requireInstitutionRole(db, user.id, institutionId, MANAGEMENT_ROLES);
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status);

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const allowedFields = ["role", "institution_plan_id", "is_active"];
  const patch: Record<string, unknown> = {};
  for (const f of allowedFields) { if (body[f] !== undefined) patch[f] = body[f]; }

  if (typeof patch.role === "string") {
    if (!VALID_ROLES.includes(patch.role as string))
      return err(c, `role must be one of: ${VALID_ROLES.join(", ")}`, 400);

    // H-3 FIX: Prevent privilege escalation when changing roles
    if (!canAssignRole(roleCheck.role, patch.role as string)) {
      return err(
        c,
        `Cannot assign role '${patch.role}' with your current role '${roleCheck.role}'`,
        403,
      );
    }
  }
  if (Object.keys(patch).length === 0) return err(c, "No valid fields to update", 400);

  patch.updated_at = new Date().toISOString();
  const { data, error } = await db.from("memberships").update(patch).eq("id", id).select().single();
  if (error) return err(c, `Update membership ${id} failed: ${error.message}`, 500);
  return ok(c, data);
});

// ── DELETE /memberships/:id ──────────────────────────────────────
// H-3 FIX: Resolve target institution, verify caller has management role.
membershipRoutes.delete(`${memBase}/:id`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const id = c.req.param("id");

  // H-3 FIX: Resolve target membership's institution, verify authority
  const institutionId = await resolveMembershipInstitution(db, id);
  if (!institutionId) return err(c, "Membership not found", 404);

  const roleCheck = await requireInstitutionRole(db, user.id, institutionId, MANAGEMENT_ROLES);
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status);

  const { data, error } = await db
    .from("memberships")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", id).eq("is_active", true).select().single();

  if (error) return err(c, `Deactivate membership ${id} failed: ${error.message}`, 500);
  return ok(c, data);
});

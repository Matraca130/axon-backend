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
 *
 * A-5 FIX: PUT now enforces role hierarchy for is_active changes.
 *   An admin cannot deactivate an owner. Destructive changes to a
 *   membership require the caller's role to be >= the target's role.
 */

import { Hono } from "npm:hono";
import { authenticate, getAdminClient, ok, err, safeJson, PREFIX } from "../../db.ts";
import { safeErr } from "../../lib/safe-error.ts";
import {
  requireInstitutionRole,
  resolveMembershipInstitution,
  isDenied,
  canAssignRole,
  ALL_ROLES,
  MANAGEMENT_ROLES,
  ROLE_HIERARCHY,
} from "../../auth-helpers.ts";
import type { Context } from "npm:hono";

export const membershipRoutes = new Hono();

const memBase = `${PREFIX}/memberships`;

// ─── Constants ────────────────────────────────────────────────────

const MAX_PAGINATION_LIMIT = 500;
const DEFAULT_PAGINATION_LIMIT = 100;
const VALID_ROLES = ["student", "professor", "admin", "owner"];

// ── GET /memberships ─────────────────────────────────────────────
membershipRoutes.get(memBase, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const institutionId = c.req.query("institution_id");
  if (!institutionId) return err(c, "Missing required query param: institution_id", 400);

  const roleCheck = await requireInstitutionRole(db, user.id, institutionId, ALL_ROLES);
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status);

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

  if (error) return safeErr(c, "List memberships", error);
  return ok(c, { items: data, total: count, limit, offset });
});

// ── GET /memberships/:id ─────────────────────────────────────────
membershipRoutes.get(`${memBase}/:id`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const id = c.req.param("id");

  const institutionId = await resolveMembershipInstitution(db, id);
  if (!institutionId) return err(c, "Membership not found", 404);

  const roleCheck = await requireInstitutionRole(db, user.id, institutionId, ALL_ROLES);
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status);

  const { data, error } = await db.from("memberships").select("*").eq("id", id).single();
  if (error) return safeErr(c, "Get membership", error, 404);
  return ok(c, data);
});

// ── POST /memberships ────────────────────────────────────────────
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

  const roleCheck = await requireInstitutionRole(db, user.id, institution_id, MANAGEMENT_ROLES);
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status);

  if (!canAssignRole(roleCheck.role, role)) {
    return err(
      c,
      `Cannot assign role '${role}' with your current role '${roleCheck.role}'`,
      403,
    );
  }

  console.warn(
    `[Axon Audit] Membership created by ${user.id} (${roleCheck.role}): ` +
    `target_user=${user_id}, institution=${institution_id}, assigned_role=${role}`,
  );

  const admin = getAdminClient();
  const row: Record<string, unknown> = { user_id, institution_id, role };
  if (typeof body.institution_plan_id === "string") row.institution_plan_id = body.institution_plan_id;

  const { data, error } = await admin.from("memberships").insert(row).select().single();
  if (error) {
    const status = error.message?.includes("duplicate") ? 409 : 500;
    return safeErr(c, "Create membership", error, status);
  }
  return ok(c, data, 201);
});

// ── PUT /memberships/:id ─────────────────────────────────────────
// A-5 FIX: Enforces role hierarchy for is_active and role changes.
// An admin (level 3) cannot deactivate or change the role of an owner (level 4).
// This prevents privilege escalation via indirect paths.
membershipRoutes.put(`${memBase}/:id`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const id = c.req.param("id");

  const institutionId = await resolveMembershipInstitution(db, id);
  if (!institutionId) return err(c, "Membership not found", 404);

  const roleCheck = await requireInstitutionRole(db, user.id, institutionId, MANAGEMENT_ROLES);
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status);

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const allowedFields = ["role", "institution_plan_id", "is_active"];
  const patch: Record<string, unknown> = {};
  for (const f of allowedFields) { if (body[f] !== undefined) patch[f] = body[f]; }

  // A-5 FIX: For destructive changes (role change or deactivation), verify
  // the caller's role is >= the target membership's current role.
  // This prevents an admin from deactivating the owner.
  const isDestructiveChange =
    (typeof patch.role === "string") ||
    (patch.is_active === false);

  if (isDestructiveChange) {
    // Fetch the target membership's current role
    const { data: targetMem, error: targetErr } = await db
      .from("memberships")
      .select("role, user_id")
      .eq("id", id)
      .single();

    if (targetErr || !targetMem) {
      return err(c, "Target membership not found", 404);
    }

    const callerLevel = ROLE_HIERARCHY[roleCheck.role] ?? 0;
    const targetLevel = ROLE_HIERARCHY[targetMem.role as string] ?? 0;

    // Caller must have >= authority than the target
    if (callerLevel < targetLevel) {
      return err(
        c,
        `Cannot modify a ${targetMem.role} membership with your ${roleCheck.role} role`,
        403,
      );
    }

    // Prevent self-deactivation if caller is the last owner
    if (patch.is_active === false && targetMem.user_id === user.id && targetMem.role === "owner") {
      // Check if there's at least one other active owner
      const { count, error: countErr } = await db
        .from("memberships")
        .select("id", { count: "exact", head: true })
        .eq("institution_id", institutionId)
        .eq("role", "owner")
        .eq("is_active", true)
        .neq("id", id);

      if (countErr || (count ?? 0) < 1) {
        return err(
          c,
          "Cannot deactivate the last owner of an institution",
          403,
        );
      }
    }
  }

  if (typeof patch.role === "string") {
    if (!VALID_ROLES.includes(patch.role as string))
      return err(c, `role must be one of: ${VALID_ROLES.join(", ")}`, 400);

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
  if (error) return safeErr(c, "Update membership", error);
  return ok(c, data);
});

// ── DELETE /memberships/:id ──────────────────────────────────────
// A-5 FIX: Also applies hierarchy check — admin can't delete owner.
membershipRoutes.delete(`${memBase}/:id`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const id = c.req.param("id");

  const institutionId = await resolveMembershipInstitution(db, id);
  if (!institutionId) return err(c, "Membership not found", 404);

  const roleCheck = await requireInstitutionRole(db, user.id, institutionId, MANAGEMENT_ROLES);
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status);

  // A-5 FIX: Verify caller has authority over the target membership
  const { data: targetMem, error: targetErr } = await db
    .from("memberships")
    .select("role, user_id")
    .eq("id", id)
    .single();

  if (targetErr || !targetMem) {
    return err(c, "Target membership not found", 404);
  }

  const callerLevel = ROLE_HIERARCHY[roleCheck.role] ?? 0;
  const targetLevel = ROLE_HIERARCHY[targetMem.role as string] ?? 0;

  if (callerLevel < targetLevel) {
    return err(
      c,
      `Cannot deactivate a ${targetMem.role} membership with your ${roleCheck.role} role`,
      403,
    );
  }

  // Prevent deleting the last owner
  if (targetMem.role === "owner") {
    const { count, error: countErr } = await db
      .from("memberships")
      .select("id", { count: "exact", head: true })
      .eq("institution_id", institutionId)
      .eq("role", "owner")
      .eq("is_active", true)
      .neq("id", id);

    if (countErr || (count ?? 0) < 1) {
      return err(c, "Cannot deactivate the last owner of an institution", 403);
    }
  }

  const { data, error } = await db
    .from("memberships")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", id).eq("is_active", true).select().single();

  if (error) return safeErr(c, "Deactivate membership", error);
  return ok(c, data);
});

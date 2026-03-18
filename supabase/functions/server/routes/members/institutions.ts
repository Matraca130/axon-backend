/**
 * routes/members/institutions.ts — Institution CRUD
 *
 * POST   /institutions        — Create institution + owner membership (admin client)
 * GET    /institutions        — List user's institutions (via memberships)
 * GET    /institutions/:id    — Get institution by ID
 * PUT    /institutions/:id    — Update institution
 * DELETE /institutions/:id    — Deactivate institution (soft)
 *
 * H-2 FIX: PUT/DELETE/GET-by-id now require institution membership.
 *   - GET /:id → any active member (ALL_ROLES)
 *   - PUT → owner or admin (MANAGEMENT_ROLES)
 *     - Admins can update name/logo_url/settings
 *     - Only owners can change slug and is_active (destructive)
 *   - DELETE → owner only
 */

import { Hono } from "npm:hono";
import { authenticate, getAdminClient, ok, err, safeJson, PREFIX } from "../../db.ts";
import { safeErr } from "../../lib/safe-error.ts";
import {
  requireInstitutionRole,
  isDenied,
  ALL_ROLES,
  MANAGEMENT_ROLES,
} from "../../auth-helpers.ts";
import { isNonEmpty } from "../../validate.ts";
import type { Context } from "npm:hono";

export const institutionRoutes = new Hono();

const instBase = `${PREFIX}/institutions`;

// ── POST /institutions ────────────────────────────────────────────────
// Creates institution + owner membership. Self-scoped (owner_id = caller).
// No authorization check needed beyond authentication.
institutionRoutes.post(instBase, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const name = body.name;
  const slug = body.slug;

  if (!isNonEmpty(name)) return err(c, "name must be a non-empty string", 400);
  if (!isNonEmpty(slug)) return err(c, "slug must be a non-empty string", 400);

  if (!/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(slug)) {
    return err(c, "slug must be 3-50 characters, lowercase alphanumeric and hyphens, cannot start/end with hyphen", 400);
  }

  const admin = getAdminClient();

  const instRow: Record<string, unknown> = { name, slug, owner_id: user.id };
  if (typeof body.logo_url === "string") instRow.logo_url = body.logo_url;
  if (typeof body.settings === "object" && body.settings !== null) instRow.settings = body.settings;

  const { data: institution, error: instError } = await admin
    .from("institutions").insert(instRow).select().single();

  if (instError) {
    const status = instError.message?.includes("duplicate") ? 409 : 500;
    return safeErr(c, "Create institution", instError, status);
  }

  const { error: memError } = await admin.from("memberships").insert({
    user_id: user.id, institution_id: institution.id, role: "owner",
  });

  if (memError) {
    console.error(`[Axon] Owner membership failed for institution ${institution.id}, rolling back: ${memError.message}`);
    await admin.from("institutions").delete().eq("id", institution.id);
    return safeErr(c, "Owner membership creation", memError);
  }

  return ok(c, institution, 201);
});

// ── GET /institutions ─────────────────────────────────────────────────
// Already scoped: queries memberships WHERE user_id = caller. No change needed.
institutionRoutes.get(instBase, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const { data, error } = await db
    .from("memberships")
    .select(`
      id, role, is_active, created_at,
      institution:institutions (
        id, name, slug, logo_url, owner_id, is_active, settings, created_at, updated_at
      )
    `)
    .eq("user_id", user.id)
    .eq("is_active", true)
    .order("created_at", { ascending: true });

  if (error) return safeErr(c, "List institutions", error);

  const institutions = (data ?? [])
    .filter((m: Record<string, unknown>) => m.institution && (m.institution as Record<string, unknown>).is_active !== false)
    .map((m: Record<string, unknown>) => ({
      ...(m.institution as Record<string, unknown>),
      membership_id: m.id,
      role: m.role,
    }));

  return ok(c, institutions);
});

// ── GET /institutions/:id ─────────────────────────────────────────────
// H-2 FIX: Verify caller is a member of this institution.
institutionRoutes.get(`${instBase}/:id`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const id = c.req.param("id");

  // H-2 FIX: Any active member can read their institution's details
  const roleCheck = await requireInstitutionRole(db, user.id, id, ALL_ROLES);
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status);

  const { data, error } = await db.from("institutions").select("*").eq("id", id).single();
  if (error) return safeErr(c, "Get institution", error, 404);
  return ok(c, data);
});

// ── PUT /institutions/:id ─────────────────────────────────────────────
// H-2 FIX: Requires owner or admin. Admins cannot change slug or is_active.
institutionRoutes.put(`${instBase}/:id`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const id = c.req.param("id");

  // H-2 FIX: Verify caller is owner or admin of this institution
  const roleCheck = await requireInstitutionRole(db, user.id, id, MANAGEMENT_ROLES);
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status);

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  // H-2 FIX: Owner-only fields — admins cannot change slug or deactivate
  const ownerOnlyFields = ["slug", "is_active"];
  const allowedFields = ["name", "slug", "logo_url", "settings", "is_active"];
  const patch: Record<string, unknown> = {};

  for (const f of allowedFields) {
    if (body[f] !== undefined) {
      if (ownerOnlyFields.includes(f) && roleCheck.role !== "owner") {
        return err(c, `Field '${f}' can only be changed by the institution owner`, 403);
      }
      patch[f] = body[f];
    }
  }
  if (Object.keys(patch).length === 0) return err(c, "No valid fields to update", 400);

  if (typeof patch.slug === "string" && !/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(patch.slug as string)) {
    return err(c, "Invalid slug format", 400);
  }

  patch.updated_at = new Date().toISOString();
  const { data, error } = await db.from("institutions").update(patch).eq("id", id).select().single();
  if (error) return safeErr(c, "Update institution", error);
  return ok(c, data);
});

// ── DELETE /institutions/:id ──────────────────────────────────────────
// H-2 FIX: Only owners can deactivate an institution.
institutionRoutes.delete(`${instBase}/:id`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const id = c.req.param("id");

  // H-2 FIX: Only institution owners can deactivate
  const roleCheck = await requireInstitutionRole(db, user.id, id, ["owner"]);
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status);

  const { data, error } = await db
    .from("institutions")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", id).eq("is_active", true).select().single();

  if (error) return safeErr(c, "Deactivate institution", error);
  return ok(c, data);
});

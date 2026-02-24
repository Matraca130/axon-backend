/**
 * routes-members.tsx — Institutions, Memberships & Admin Scopes for Axon v4.4
 *
 * Institutions:
 *   POST   /institutions        — Create institution + owner membership (admin client)
 *   GET    /institutions        — List user's institutions (via memberships)
 *   GET    /institutions/:id    — Get institution by ID
 *   PUT    /institutions/:id    — Update institution
 *   DELETE /institutions/:id    — Deactivate institution (soft)
 *
 * Memberships:
 *   GET    /memberships         — List memberships for an institution
 *   POST   /memberships         — Add member to institution
 *   PUT    /memberships/:id     — Update membership (role, plan, is_active)
 *   DELETE /memberships/:id     — Deactivate membership (soft)
 *
 * Admin Scopes:
 *   GET    /admin-scopes        — List scopes for a membership
 *   POST   /admin-scopes        — Add scope to membership
 *   DELETE /admin-scopes/:id    — Remove scope (hard delete)
 *
 * Authorization is enforced by RLS where possible. Institution creation uses
 * admin client because the owner membership cannot exist before the institution.
 */

import { Hono } from "npm:hono";
import {
  authenticate,
  getAdminClient,
  ok,
  err,
  safeJson,
  PREFIX,
} from "./db.ts";
import { isNonEmpty } from "./validate.ts";
import type { Context } from "npm:hono";

const memberRoutes = new Hono();

// ═══════════════════════════════════════════════════════════════════════
// INSTITUTIONS
// ═══════════════════════════════════════════════════════════════════════

const instBase = `${PREFIX}/institutions`;

// ── POST /institutions ────────────────────────────────────────────────
// Creates institution + owner membership atomically.
// Uses admin client to bypass RLS chicken-and-egg: you can't have a
// membership before the institution exists.

memberRoutes.post(instBase, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const name = body.name;
  const slug = body.slug;

  if (!isNonEmpty(name)) {
    return err(c, "name must be a non-empty string", 400);
  }
  if (!isNonEmpty(slug)) {
    return err(c, "slug must be a non-empty string", 400);
  }

  // Validate slug format: lowercase alphanumeric + hyphens, 3-50 chars
  if (!/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(slug)) {
    return err(
      c,
      "slug must be 3-50 characters, lowercase alphanumeric and hyphens, cannot start/end with hyphen",
      400,
    );
  }

  const admin = getAdminClient();

  // Step 1: Create institution
  const instRow: Record<string, unknown> = {
    name,
    slug,
    owner_id: user.id,
  };
  if (typeof body.logo_url === "string") instRow.logo_url = body.logo_url;
  if (typeof body.settings === "object" && body.settings !== null) {
    instRow.settings = body.settings;
  }

  const { data: institution, error: instError } = await admin
    .from("institutions")
    .insert(instRow)
    .select()
    .single();

  if (instError) {
    return err(
      c,
      `Create institution failed: ${instError.message}`,
      instError.message.includes("duplicate") ? 409 : 500,
    );
  }

  // Step 2: Create owner membership
  const { error: memError } = await admin.from("memberships").insert({
    user_id: user.id,
    institution_id: institution.id,
    role: "owner",
  });

  if (memError) {
    // Rollback: delete institution
    console.error(
      `[Axon] Owner membership failed for institution ${institution.id}, rolling back: ${memError.message}`,
    );
    await admin.from("institutions").delete().eq("id", institution.id);
    return err(
      c,
      `Owner membership creation failed (institution rolled back): ${memError.message}`,
      500,
    );
  }

  return ok(c, institution, 201);
});

// ── GET /institutions ─────────────────────────────────────────────────
// List institutions where the current user has an active membership.
// Uses PostgREST embedding: memberships -> institutions.

memberRoutes.get(instBase, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const { data, error } = await db
    .from("memberships")
    .select(
      `
      id, role, is_active, created_at,
      institution:institutions (
        id, name, slug, logo_url, owner_id, is_active, settings, created_at, updated_at
      )
    `,
    )
    .eq("user_id", user.id)
    .eq("is_active", true)
    .order("created_at", { ascending: true });

  if (error) {
    return err(c, `List institutions failed: ${error.message}`, 500);
  }

  // Flatten: return institutions with the user's role attached
  const institutions = (data ?? [])
    .filter(
      (m: Record<string, unknown>) =>
        m.institution && (m.institution as Record<string, unknown>).is_active !== false,
    )
    .map((m: Record<string, unknown>) => ({
      ...(m.institution as Record<string, unknown>),
      membership_id: m.id,
      role: m.role,
    }));

  return ok(c, institutions);
});

// ── GET /institutions/:id ─────────────────────────────────────────────
memberRoutes.get(`${instBase}/:id`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const id = c.req.param("id");
  const { data, error } = await db
    .from("institutions")
    .select("*")
    .eq("id", id)
    .single();

  if (error) {
    return err(c, `Get institution ${id} failed: ${error.message}`, 404);
  }
  return ok(c, data);
});

// ── PUT /institutions/:id ─────────────────────────────────────────────
// Allowed fields: name, slug, logo_url, settings, is_active
// RLS should restrict to owner/admin.

memberRoutes.put(`${instBase}/:id`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const id = c.req.param("id");
  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const allowedFields = ["name", "slug", "logo_url", "settings", "is_active"];
  const patch: Record<string, unknown> = {};

  for (const f of allowedFields) {
    if (body[f] !== undefined) patch[f] = body[f];
  }

  if (Object.keys(patch).length === 0) {
    return err(c, "No valid fields to update", 400);
  }

  // Validate slug if being updated
  if (typeof patch.slug === "string") {
    if (!/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(patch.slug as string)) {
      return err(c, "Invalid slug format", 400);
    }
  }

  patch.updated_at = new Date().toISOString();

  const { data, error } = await db
    .from("institutions")
    .update(patch)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    return err(c, `Update institution ${id} failed: ${error.message}`, 500);
  }
  return ok(c, data);
});

// ── DELETE /institutions/:id ──────────────────────────────────────────
// Soft-deactivate: sets is_active = false.

memberRoutes.delete(`${instBase}/:id`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const id = c.req.param("id");

  const { data, error } = await db
    .from("institutions")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("is_active", true)
    .select()
    .single();

  if (error) {
    return err(
      c,
      `Deactivate institution ${id} failed: ${error.message}`,
      500,
    );
  }
  return ok(c, data);
});

// ═══════════════════════════════════════════════════════════════════════
// MEMBERSHIPS
// ═══════════════════════════════════════════════════════════════════════

const memBase = `${PREFIX}/memberships`;

// ── GET /memberships?institution_id=xxx ────────────────────────────────
memberRoutes.get(memBase, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const institutionId = c.req.query("institution_id");
  if (!institutionId) {
    return err(c, "Missing required query param: institution_id", 400);
  }

  const { data, error } = await db
    .from("memberships")
    .select("*")
    .eq("institution_id", institutionId)
    .order("created_at", { ascending: true });

  if (error) {
    return err(c, `List memberships failed: ${error.message}`, 500);
  }
  return ok(c, data);
});

// ── GET /memberships/:id ──────────────────────────────────────────────
memberRoutes.get(`${memBase}/:id`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const id = c.req.param("id");
  const { data, error } = await db
    .from("memberships")
    .select("*")
    .eq("id", id)
    .single();

  if (error) {
    return err(c, `Get membership ${id} failed: ${error.message}`, 404);
  }
  return ok(c, data);
});

// ── POST /memberships ─────────────────────────────────────────────────
// Add a member to an institution. Requires user_id and institution_id.
// Uses admin client because the new user might not have RLS access yet.

memberRoutes.post(memBase, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const user_id = body.user_id;
  const institution_id = body.institution_id;
  const role = body.role;

  if (typeof user_id !== "string" || typeof institution_id !== "string") {
    return err(c, "user_id and institution_id must be strings", 400);
  }

  const validRoles = ["student", "professor", "admin", "owner"];
  if (typeof role !== "string" || !validRoles.includes(role)) {
    return err(c, `role must be one of: ${validRoles.join(", ")}`, 400);
  }

  const admin = getAdminClient();

  const row: Record<string, unknown> = { user_id, institution_id, role };
  if (typeof body.institution_plan_id === "string") {
    row.institution_plan_id = body.institution_plan_id;
  }

  const { data, error } = await admin
    .from("memberships")
    .insert(row)
    .select()
    .single();

  if (error) {
    return err(
      c,
      `Create membership failed: ${error.message}`,
      error.message.includes("duplicate") ? 409 : 500,
    );
  }

  return ok(c, data, 201);
});

// ── PUT /memberships/:id ──────────────────────────────────────────────
// Update role, institution_plan_id, or is_active.

memberRoutes.put(`${memBase}/:id`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const id = c.req.param("id");
  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const allowedFields = ["role", "institution_plan_id", "is_active"];
  const patch: Record<string, unknown> = {};

  for (const f of allowedFields) {
    if (body[f] !== undefined) patch[f] = body[f];
  }

  // Validate role if provided
  if (typeof patch.role === "string") {
    const validRoles = ["student", "professor", "admin", "owner"];
    if (!validRoles.includes(patch.role as string)) {
      return err(c, `role must be one of: ${validRoles.join(", ")}`, 400);
    }
  }

  if (Object.keys(patch).length === 0) {
    return err(c, "No valid fields to update", 400);
  }

  patch.updated_at = new Date().toISOString();

  const { data, error } = await db
    .from("memberships")
    .update(patch)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    return err(c, `Update membership ${id} failed: ${error.message}`, 500);
  }
  return ok(c, data);
});

// ── DELETE /memberships/:id ───────────────────────────────────────────
// Soft-deactivate: sets is_active = false.

memberRoutes.delete(`${memBase}/:id`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const id = c.req.param("id");

  const { data, error } = await db
    .from("memberships")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("is_active", true)
    .select()
    .single();

  if (error) {
    return err(
      c,
      `Deactivate membership ${id} failed: ${error.message}`,
      500,
    );
  }
  return ok(c, data);
});

// ═══════════════════════════════════════════════════════════════════════
// ADMIN SCOPES
// ═══════════════════════════════════════════════════════════════════════

const scopeBase = `${PREFIX}/admin-scopes`;

// ── GET /admin-scopes?membership_id=xxx ───────────────────────────────
memberRoutes.get(scopeBase, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const membershipId = c.req.query("membership_id");
  if (!membershipId) {
    return err(c, "Missing required query param: membership_id", 400);
  }

  const { data, error } = await db
    .from("admin_scopes")
    .select("*")
    .eq("membership_id", membershipId)
    .order("created_at", { ascending: true });

  if (error) {
    return err(c, `List admin_scopes failed: ${error.message}`, 500);
  }
  return ok(c, data);
});

// ── POST /admin-scopes ────────────────────────────────────────────────
memberRoutes.post(scopeBase, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const membership_id = body.membership_id;
  const scope_type = body.scope_type;

  if (typeof membership_id !== "string" || typeof scope_type !== "string") {
    return err(c, "membership_id and scope_type must be strings", 400);
  }

  const row: Record<string, unknown> = { membership_id, scope_type };
  // scope_id is nullable — used when scope_type targets a specific entity
  if (typeof body.scope_id === "string") {
    row.scope_id = body.scope_id;
  }

  const { data, error } = await db
    .from("admin_scopes")
    .insert(row)
    .select()
    .single();

  if (error) {
    return err(c, `Create admin_scope failed: ${error.message}`, 500);
  }
  return ok(c, data, 201);
});

// ── DELETE /admin-scopes/:id ──────────────────────────────────────────
// Hard delete — scopes are configuration, not sacred data.
memberRoutes.delete(`${scopeBase}/:id`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const id = c.req.param("id");
  const { error } = await db.from("admin_scopes").delete().eq("id", id);
  if (error) {
    return err(c, `Delete admin_scope ${id} failed: ${error.message}`, 500);
  }
  return ok(c, { deleted: id });
});

export { memberRoutes };
/**
 * routes/members/memberships.ts — Membership CRUD
 *
 * GET    /memberships         — List memberships for an institution
 * GET    /memberships/:id     — Get membership by ID
 * POST   /memberships         — Add member to institution (admin client)
 * PUT    /memberships/:id     — Update membership (role, plan, is_active)
 * DELETE /memberships/:id     — Deactivate membership (soft)
 */

import { Hono } from "npm:hono";
import { authenticate, getAdminClient, ok, err, safeJson, PREFIX } from "../../db.ts";
import type { Context } from "npm:hono";

export const membershipRoutes = new Hono();

const memBase = `${PREFIX}/memberships`;

membershipRoutes.get(memBase, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const institutionId = c.req.query("institution_id");
  if (!institutionId) return err(c, "Missing required query param: institution_id", 400);

  const { data, error } = await db
    .from("memberships").select("*")
    .eq("institution_id", institutionId)
    .order("created_at", { ascending: true });

  if (error) return err(c, `List memberships failed: ${error.message}`, 500);
  return ok(c, data);
});

membershipRoutes.get(`${memBase}/:id`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const id = c.req.param("id");
  const { data, error } = await db.from("memberships").select("*").eq("id", id).single();
  if (error) return err(c, `Get membership ${id} failed: ${error.message}`, 404);
  return ok(c, data);
});

membershipRoutes.post(memBase, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const { user_id, institution_id, role } = body;
  if (typeof user_id !== "string" || typeof institution_id !== "string")
    return err(c, "user_id and institution_id must be strings", 400);

  const validRoles = ["student", "professor", "admin", "owner"];
  if (typeof role !== "string" || !validRoles.includes(role))
    return err(c, `role must be one of: ${validRoles.join(", ")}`, 400);

  const admin = getAdminClient();
  const row: Record<string, unknown> = { user_id, institution_id, role };
  if (typeof body.institution_plan_id === "string") row.institution_plan_id = body.institution_plan_id;

  const { data, error } = await admin.from("memberships").insert(row).select().single();
  if (error) return err(c, `Create membership failed: ${error.message}`, error.message.includes("duplicate") ? 409 : 500);
  return ok(c, data, 201);
});

membershipRoutes.put(`${memBase}/:id`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const id = c.req.param("id");
  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const allowedFields = ["role", "institution_plan_id", "is_active"];
  const patch: Record<string, unknown> = {};
  for (const f of allowedFields) { if (body[f] !== undefined) patch[f] = body[f]; }

  if (typeof patch.role === "string") {
    const validRoles = ["student", "professor", "admin", "owner"];
    if (!validRoles.includes(patch.role as string)) return err(c, `role must be one of: ${validRoles.join(", ")}`, 400);
  }
  if (Object.keys(patch).length === 0) return err(c, "No valid fields to update", 400);

  patch.updated_at = new Date().toISOString();
  const { data, error } = await db.from("memberships").update(patch).eq("id", id).select().single();
  if (error) return err(c, `Update membership ${id} failed: ${error.message}`, 500);
  return ok(c, data);
});

membershipRoutes.delete(`${memBase}/:id`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const id = c.req.param("id");
  const { data, error } = await db
    .from("memberships")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", id).eq("is_active", true).select().single();

  if (error) return err(c, `Deactivate membership ${id} failed: ${error.message}`, 500);
  return ok(c, data);
});

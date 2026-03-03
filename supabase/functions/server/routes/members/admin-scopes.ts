/**
 * routes/members/admin-scopes.ts — Admin scope management
 *
 * GET    /admin-scopes        — List scopes for a membership
 * POST   /admin-scopes        — Add scope to membership
 * DELETE /admin-scopes/:id    — Remove scope (hard delete)
 */

import { Hono } from "npm:hono";
import { authenticate, ok, err, safeJson, PREFIX } from "../../db.ts";
import type { Context } from "npm:hono";

export const adminScopeRoutes = new Hono();

const scopeBase = `${PREFIX}/admin-scopes`;

adminScopeRoutes.get(scopeBase, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const membershipId = c.req.query("membership_id");
  if (!membershipId) return err(c, "Missing required query param: membership_id", 400);

  const { data, error } = await db
    .from("admin_scopes").select("*")
    .eq("membership_id", membershipId)
    .order("created_at", { ascending: true });

  if (error) return err(c, `List admin_scopes failed: ${error.message}`, 500);
  return ok(c, data);
});

adminScopeRoutes.post(scopeBase, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const { membership_id, scope_type } = body;
  if (typeof membership_id !== "string" || typeof scope_type !== "string")
    return err(c, "membership_id and scope_type must be strings", 400);

  const row: Record<string, unknown> = { membership_id, scope_type };
  if (typeof body.scope_id === "string") row.scope_id = body.scope_id;

  const { data, error } = await db.from("admin_scopes").insert(row).select().single();
  if (error) return err(c, `Create admin_scope failed: ${error.message}`, 500);
  return ok(c, data, 201);
});

adminScopeRoutes.delete(`${scopeBase}/:id`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const id = c.req.param("id");
  const { error } = await db.from("admin_scopes").delete().eq("id", id);
  if (error) return err(c, `Delete admin_scope ${id} failed: ${error.message}`, 500);
  return ok(c, { deleted: id });
});

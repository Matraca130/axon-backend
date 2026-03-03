/**
 * routes/members/institutions.ts — Institution CRUD
 *
 * POST   /institutions        — Create institution + owner membership (admin client)
 * GET    /institutions        — List user's institutions (via memberships)
 * GET    /institutions/:id    — Get institution by ID
 * PUT    /institutions/:id    — Update institution
 * DELETE /institutions/:id    — Deactivate institution (soft)
 */

import { Hono } from "npm:hono";
import { authenticate, getAdminClient, ok, err, safeJson, PREFIX } from "../../db.ts";
import { isNonEmpty } from "../../validate.ts";
import type { Context } from "npm:hono";

export const institutionRoutes = new Hono();

const instBase = `${PREFIX}/institutions`;

// ── POST /institutions ────────────────────────────────────────────────
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
    return err(c, `Create institution failed: ${instError.message}`, instError.message.includes("duplicate") ? 409 : 500);
  }

  const { error: memError } = await admin.from("memberships").insert({
    user_id: user.id, institution_id: institution.id, role: "owner",
  });

  if (memError) {
    console.error(`[Axon] Owner membership failed for institution ${institution.id}, rolling back: ${memError.message}`);
    await admin.from("institutions").delete().eq("id", institution.id);
    return err(c, `Owner membership creation failed (institution rolled back): ${memError.message}`, 500);
  }

  return ok(c, institution, 201);
});

// ── GET /institutions ─────────────────────────────────────────────────
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

  if (error) return err(c, `List institutions failed: ${error.message}`, 500);

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
institutionRoutes.get(`${instBase}/:id`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const id = c.req.param("id");
  const { data, error } = await db.from("institutions").select("*").eq("id", id).single();
  if (error) return err(c, `Get institution ${id} failed: ${error.message}`, 404);
  return ok(c, data);
});

// ── PUT /institutions/:id ─────────────────────────────────────────────
institutionRoutes.put(`${instBase}/:id`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const id = c.req.param("id");
  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const allowedFields = ["name", "slug", "logo_url", "settings", "is_active"];
  const patch: Record<string, unknown> = {};
  for (const f of allowedFields) { if (body[f] !== undefined) patch[f] = body[f]; }
  if (Object.keys(patch).length === 0) return err(c, "No valid fields to update", 400);

  if (typeof patch.slug === "string" && !/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(patch.slug as string)) {
    return err(c, "Invalid slug format", 400);
  }

  patch.updated_at = new Date().toISOString();
  const { data, error } = await db.from("institutions").update(patch).eq("id", id).select().single();
  if (error) return err(c, `Update institution ${id} failed: ${error.message}`, 500);
  return ok(c, data);
});

// ── DELETE /institutions/:id ──────────────────────────────────────────
institutionRoutes.delete(`${instBase}/:id`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const id = c.req.param("id");
  const { data, error } = await db
    .from("institutions")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", id).eq("is_active", true).select().single();

  if (error) return err(c, `Deactivate institution ${id} failed: ${error.message}`, 500);
  return ok(c, data);
});

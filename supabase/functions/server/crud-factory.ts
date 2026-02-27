/**
 * crud-factory.ts — Generic CRUD route factory for Axon v4.4
 *
 * Generates LIST / GET / POST / PUT / DELETE / RESTORE routes for any
 * table that follows standard Axon patterns. Shared by routes-content.tsx
 * and routes-student.tsx.
 *
 * Config flags:
 *   parentKey       — FK column required on LIST + CREATE (e.g. "institution_id")
 *   optionalFilters — extra query params accepted on LIST (e.g. ["keyword_id"])
 *   scopeToUser     — column auto-set to user.id on CREATE, auto-filtered on LIST/GET/UPDATE/DELETE
 *   hasCreatedBy    — sets created_by = user.id on CREATE (not filtered on LIST)
 *   hasIsActive     — when softDelete, also toggles is_active (default true; false for student notes)
 *
 * N-9 FIX: Pagination limit capped at 500, offset validated >= 0.
 * O-5 FIX: GET /:id now applies scopeToUser filter (was missing before).
 */

import { Hono } from "npm:hono";
import { authenticate, ok, err, safeJson, PREFIX } from "./db.ts";
import type { Context } from "npm:hono";

// ─── Constants ────────────────────────────────────────────────────────

const MAX_PAGINATION_LIMIT = 500;
const DEFAULT_PAGINATION_LIMIT = 100;

// ─── Types ────────────────────────────────────────────────────────────

export interface CrudConfig {
  table: string;
  slug: string;
  parentKey?: string;
  optionalFilters?: string[];
  scopeToUser?: string;
  hasCreatedBy?: boolean;
  hasUpdatedAt?: boolean;
  hasOrderIndex?: boolean;
  softDelete?: boolean;
  hasIsActive?: boolean;
  requiredFields?: string[];
  createFields: string[];
  updateFields: string[];
}

// ─── Pagination Helper ────────────────────────────────────────────────

function parsePagination(c: Context): { limit: number; offset: number } {
  let limit = parseInt(c.req.query("limit") ?? String(DEFAULT_PAGINATION_LIMIT), 10);
  let offset = parseInt(c.req.query("offset") ?? "0", 10);

  if (isNaN(limit) || limit < 1) limit = DEFAULT_PAGINATION_LIMIT;
  if (limit > MAX_PAGINATION_LIMIT) limit = MAX_PAGINATION_LIMIT;
  if (isNaN(offset) || offset < 0) offset = 0;

  return { limit, offset };
}

// ─── Factory ──────────────────────────────────────────────────────────

export function registerCrud(app: Hono, cfg: CrudConfig) {
  const base = `${PREFIX}/${cfg.slug}`;

  const isActiveSoftDelete = cfg.softDelete && cfg.hasIsActive !== false;

  // ── LIST ──────────────────────────────────────────────────────
  app.get(base, async (c: Context) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    let query = db.from(cfg.table).select("*", { count: "exact" });

    if (cfg.parentKey) {
      const parentValue = c.req.query(cfg.parentKey);
      if (!parentValue) {
        return err(c, `Missing required query param: ${cfg.parentKey}`, 400);
      }
      query = query.eq(cfg.parentKey, parentValue);
    }

    if (cfg.optionalFilters) {
      for (const f of cfg.optionalFilters) {
        const v = c.req.query(f);
        if (v) query = query.eq(f, v);
      }
    }

    if (cfg.scopeToUser) {
      query = query.eq(cfg.scopeToUser, user.id);
    }

    if (cfg.softDelete) {
      const includeDeleted = c.req.query("include_deleted") === "true";
      if (!includeDeleted) {
        query = query.is("deleted_at", null);
      }
    }

    const orderCol = cfg.hasOrderIndex ? "order_index" : "created_at";
    query = query.order(orderCol, { ascending: true });

    const { limit, offset } = parsePagination(c);
    query = query.range(offset, offset + limit - 1);

    const { data, count, error } = await query;
    if (error) return err(c, `List ${cfg.table} failed: ${error.message}`, 500);
    return ok(c, { items: data, total: count, limit, offset });
  });

  // ── GET BY ID ─────────────────────────────────────────────────
  // O-5 FIX: Now applies scopeToUser filter (matches LIST/UPDATE/DELETE)
  app.get(`${base}/:id`, async (c: Context) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    const id = c.req.param("id");
    let query = db.from(cfg.table).select("*").eq("id", id);

    // Scope: students can only read their own records
    if (cfg.scopeToUser) {
      query = query.eq(cfg.scopeToUser, user.id);
    }

    const { data, error } = await query.single();
    if (error)
      return err(c, `Get ${cfg.table} ${id} failed: ${error.message}`, 404);
    return ok(c, data);
  });

  // ── CREATE ────────────────────────────────────────────────────
  app.post(base, async (c: Context) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    const body = await safeJson(c);
    if (!body) return err(c, "Invalid or missing JSON body", 400);
    const row: Record<string, unknown> = {};

    if (cfg.parentKey) {
      if (!body[cfg.parentKey]) {
        return err(c, `Missing required field: ${cfg.parentKey}`, 400);
      }
      row[cfg.parentKey] = body[cfg.parentKey];
    }

    if (cfg.requiredFields) {
      const missing = cfg.requiredFields.filter((f) => {
        const v = body[f];
        if (v === 0 || v === false) return false;
        if (!v) return true;
        if (typeof v === "string" && v.trim().length === 0) return true;
        return false;
      });
      if (missing.length > 0) {
        return err(c, `Missing required fields: ${missing.join(", ")}`, 400);
      }
    }

    for (const f of cfg.createFields) {
      if (body[f] !== undefined) row[f] = body[f];
    }

    if (cfg.hasCreatedBy) row.created_by = user.id;
    if (cfg.scopeToUser) row[cfg.scopeToUser] = user.id;

    const { data, error } = await db
      .from(cfg.table)
      .insert(row)
      .select()
      .single();
    if (error)
      return err(c, `Create ${cfg.table} failed: ${error.message}`, 500);
    return ok(c, data, 201);
  });

  // ── UPDATE ────────────────────────────────────────────────────
  app.put(`${base}/:id`, async (c: Context) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    const id = c.req.param("id");
    const body = await safeJson(c);
    if (!body) return err(c, "Invalid or missing JSON body", 400);
    const row: Record<string, unknown> = {};

    for (const f of cfg.updateFields) {
      if (body[f] !== undefined) row[f] = body[f];
    }

    if (Object.keys(row).length === 0) {
      return err(c, "No valid fields to update", 400);
    }

    if (cfg.hasUpdatedAt) row.updated_at = new Date().toISOString();

    let query = db.from(cfg.table).update(row).eq("id", id);
    if (cfg.scopeToUser) query = query.eq(cfg.scopeToUser, user.id);

    const { data, error } = await query.select().single();
    if (error)
      return err(c, `Update ${cfg.table} ${id} failed: ${error.message}`, 500);
    return ok(c, data);
  });

  // ── DELETE ────────────────────────────────────────────────────
  app.delete(`${base}/:id`, async (c: Context) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    const id = c.req.param("id");

    if (cfg.softDelete) {
      const patch: Record<string, unknown> = {
        deleted_at: new Date().toISOString(),
      };
      if (isActiveSoftDelete) patch.is_active = false;
      if (cfg.hasUpdatedAt) patch.updated_at = new Date().toISOString();

      let query = db
        .from(cfg.table)
        .update(patch)
        .eq("id", id)
        .is("deleted_at", null);
      if (cfg.scopeToUser) query = query.eq(cfg.scopeToUser, user.id);

      const { data, error } = await query.select().single();
      if (error)
        return err(
          c,
          `Soft-delete ${cfg.table} ${id} failed: ${error.message}`,
          500,
        );
      return ok(c, data);
    } else {
      let query = db.from(cfg.table).delete().eq("id", id);
      if (cfg.scopeToUser) query = query.eq(cfg.scopeToUser, user.id);

      const { error } = await query;
      if (error)
        return err(
          c,
          `Delete ${cfg.table} ${id} failed: ${error.message}`,
          500,
        );
      return ok(c, { deleted: id });
    }
  });

  // ── RESTORE (soft-delete tables only) ─────────────────────────
  if (cfg.softDelete) {
    app.put(`${base}/:id/restore`, async (c: Context) => {
      const auth = await authenticate(c);
      if (auth instanceof Response) return auth;
      const { user, db } = auth;

      const id = c.req.param("id");
      const patch: Record<string, unknown> = { deleted_at: null };
      if (isActiveSoftDelete) patch.is_active = true;
      if (cfg.hasUpdatedAt) patch.updated_at = new Date().toISOString();

      let query = db
        .from(cfg.table)
        .update(patch)
        .eq("id", id)
        .not("deleted_at", "is", null);
      if (cfg.scopeToUser) query = query.eq(cfg.scopeToUser, user.id);

      const { data, error } = await query.select().single();
      if (error)
        return err(
          c,
          `Restore ${cfg.table} ${id} failed: ${error.message}`,
          500,
        );
      return ok(c, data);
    });
  }
}

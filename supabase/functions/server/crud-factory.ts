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
 *   scopeToUser     — column auto-set to user.id on CREATE, auto-filtered on LIST/UPDATE/DELETE
 *   hasCreatedBy    — sets created_by = user.id on CREATE (not filtered on LIST)
 *   hasIsActive     — when softDelete, also toggles is_active (default true; false for student notes)
 *
 * N-9 FIX: Pagination limit capped at 500, offset validated >= 0.
 */

import { Hono } from "npm:hono";
import { authenticate, ok, err, safeJson, PREFIX } from "./db.ts";
import type { Context } from "npm:hono";

// ─── Constants ────────────────────────────────────────────────────────

const MAX_PAGINATION_LIMIT = 500;
const DEFAULT_PAGINATION_LIMIT = 100;

// ─── Types ────────────────────────────────────────────────────────────

export interface CrudConfig {
  /** Postgres table name */
  table: string;
  /** URL segment (e.g. "courses") */
  slug: string;
  /** FK column that scopes this entity to its parent. Required on LIST & CREATE. */
  parentKey?: string;
  /** Additional query params accepted on LIST (e.g. ["keyword_id"]). */
  optionalFilters?: string[];
  /**
   * Column scoped to the authenticated user. Auto-set on CREATE,
   * auto-filtered on LIST / UPDATE / DELETE. Use for student-owned data.
   */
  scopeToUser?: string;
  /** Table has a `created_by` column. Auto-set from auth user on CREATE. */
  hasCreatedBy?: boolean;
  /** Table has an `updated_at` column. Auto-set on UPDATE. */
  hasUpdatedAt?: boolean;
  /** Order LIST by `order_index` (true) or `created_at` (false). */
  hasOrderIndex?: boolean;
  /**
   * Use soft-delete (set deleted_at) instead of hard DELETE.
   * If hasIsActive is true (default), also sets is_active = false.
   */
  softDelete?: boolean;
  /**
   * Whether the table has an `is_active` column (only relevant when softDelete = true).
   * Defaults to true. Set to false for tables like kw_student_notes that have
   * deleted_at but no is_active.
   */
  hasIsActive?: boolean;
  /** Fields REQUIRED on CREATE. Returns 400 if any are missing. */
  requiredFields?: string[];
  /** Fields the client CAN send on CREATE. parentKey and created_by are auto-added. */
  createFields: string[];
  /** Fields the client CAN send on UPDATE. */
  updateFields: string[];
}

// ─── Pagination Helper ────────────────────────────────────────────────

/** Parse and validate pagination params with hard caps. */
function parsePagination(c: Context): { limit: number; offset: number } {
  let limit = parseInt(c.req.query("limit") ?? String(DEFAULT_PAGINATION_LIMIT), 10);
  let offset = parseInt(c.req.query("offset") ?? "0", 10);

  // N-9 FIX: Validate and cap pagination params
  if (isNaN(limit) || limit < 1) limit = DEFAULT_PAGINATION_LIMIT;
  if (limit > MAX_PAGINATION_LIMIT) limit = MAX_PAGINATION_LIMIT;
  if (isNaN(offset) || offset < 0) offset = 0;

  return { limit, offset };
}

// ─── Factory ──────────────────────────────────────────────────────────

export function registerCrud(app: Hono, cfg: CrudConfig) {
  const base = `${PREFIX}/${cfg.slug}`;

  // Resolve hasIsActive: default true when softDelete is true
  const isActiveSoftDelete = cfg.softDelete && cfg.hasIsActive !== false;

  // ── LIST ──────────────────────────────────────────────────────
  app.get(base, async (c: Context) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    let query = db.from(cfg.table).select("*", { count: "exact" });

    // Parent filter (required when configured)
    if (cfg.parentKey) {
      const parentValue = c.req.query(cfg.parentKey);
      if (!parentValue) {
        return err(c, `Missing required query param: ${cfg.parentKey}`, 400);
      }
      query = query.eq(cfg.parentKey, parentValue);
    }

    // Optional filters
    if (cfg.optionalFilters) {
      for (const f of cfg.optionalFilters) {
        const v = c.req.query(f);
        if (v) query = query.eq(f, v);
      }
    }

    // Scope to authenticated user (student-owned data)
    if (cfg.scopeToUser) {
      query = query.eq(cfg.scopeToUser, user.id);
    }

    // Soft-delete: hide deleted records by default
    if (cfg.softDelete) {
      const includeDeleted = c.req.query("include_deleted") === "true";
      if (!includeDeleted) {
        query = query.is("deleted_at", null);
      }
    }

    // Order
    const orderCol = cfg.hasOrderIndex ? "order_index" : "created_at";
    query = query.order(orderCol, { ascending: true });

    // Pagination (N-9 FIX: validated + capped)
    const { limit, offset } = parsePagination(c);
    query = query.range(offset, offset + limit - 1);

    const { data, count, error } = await query;
    if (error) return err(c, `List ${cfg.table} failed: ${error.message}`, 500);
    return ok(c, { items: data, total: count, limit, offset });
  });

  // ── GET BY ID ─────────────────────────────────────────────────
  app.get(`${base}/:id`, async (c: Context) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { db } = auth;

    const id = c.req.param("id");
    const { data, error } = await db
      .from(cfg.table)
      .select("*")
      .eq("id", id)
      .single();
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

    // Parent FK (required on create)
    if (cfg.parentKey) {
      if (!body[cfg.parentKey]) {
        return err(c, `Missing required field: ${cfg.parentKey}`, 400);
      }
      row[cfg.parentKey] = body[cfg.parentKey];
    }

    // Required fields validation
    // Catches: undefined, null, "", "   " (whitespace-only strings)
    // Allows: 0, false (valid non-empty values)
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

    // Pick allowed create fields
    for (const f of cfg.createFields) {
      if (body[f] !== undefined) row[f] = body[f];
    }

    // Auto-set created_by
    if (cfg.hasCreatedBy) row.created_by = user.id;

    // Auto-set scope to user (e.g. student_id)
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

    // Scope: students can only update their own records
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
        .is("deleted_at", null); // prevent double-delete
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
        .not("deleted_at", "is", null); // only restore deleted records
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

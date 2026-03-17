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
 *   afterWrite      — optional fire-and-forget hook called after successful POST or PUT (Fase 5)
 *
 * N-9 FIX: Pagination limit capped at 500, offset validated >= 0.
 * O-5 FIX: GET /:id now applies scopeToUser filter (was missing before).
 * S-1 FIX: Default count mode changed to "estimated" for performance.
 *
 * H-5 FIX: Institution scoping added to all 6 endpoint types.
 * A-10 FIX: Institution scoping only applies to KNOWN content-hierarchy parentKeys.
 * A-2 FIX: POST validates requiredFields BEFORE calling checkContentScope.
 *
 * PR #105: Exported pure helpers for testing:
 *   isContentHierarchyParent, PARENT_KEY_TO_TABLE,
 *   MAX_PAGINATION_LIMIT, DEFAULT_PAGINATION_LIMIT
 */

import { Hono } from "npm:hono";
import { authenticate, ok, err, safeJson, PREFIX } from "./db.ts";
import {
  requireInstitutionRole,
  isDenied,
  ALL_ROLES,
  CONTENT_WRITE_ROLES,
} from "./auth-helpers.ts";
import type { Context } from "npm:hono";

// ─── Constants (PR #105: exported for testing) ─────────────────

export const MAX_PAGINATION_LIMIT = 500;
export const DEFAULT_PAGINATION_LIMIT = 100;

// ─── H-5 + A-10: Parent key to table mapping (PR #105: exported) ──

export const PARENT_KEY_TO_TABLE: Record<string, string> = {
  course_id: "courses",
  semester_id: "semesters",
  section_id: "sections",
  topic_id: "topics",
  summary_id: "summaries",
  keyword_id: "keywords",
  model_id: "models_3d",
};

// ─── Types ──────────────────────────────────────────────────────

/**
 * Parameters passed to the afterWrite lifecycle hook.
 * Exported for use by hook implementations (e.g. summary-hook.ts).
 */
export interface AfterWriteParams {
  /** Whether the write was a create (POST) or update (PUT) */
  action: "create" | "update";
  /** The full row returned by Supabase after .select() */
  row: Record<string, unknown>;
  /** For "update" only: the field names the client actually sent (excludes updated_at) */
  updatedFields?: string[];
  /** The authenticated user's ID */
  userId: string;
}

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
  /**
   * Optional lifecycle hook called after successful POST or PUT.
   *
   * Fire-and-forget — the factory does NOT await the hook. If the hook
   * starts async work (e.g. embedding generation), it manages its own
   * error handling via .catch(). The HTTP response is NEVER delayed
   * by this hook. NOT called on DELETE or RESTORE operations.
   */
  afterWrite?: (params: AfterWriteParams) => void;
}

// ─── Pagination Helper ─────────────────────────────────────────

function parsePagination(c: Context): { limit: number; offset: number } {
  let limit = parseInt(c.req.query("limit") ?? String(DEFAULT_PAGINATION_LIMIT), 10);
  let offset = parseInt(c.req.query("offset") ?? "0", 10);

  if (isNaN(limit) || limit < 1) limit = DEFAULT_PAGINATION_LIMIT;
  if (limit > MAX_PAGINATION_LIMIT) limit = MAX_PAGINATION_LIMIT;
  if (isNaN(offset) || offset < 0) offset = 0;

  return { limit, offset };
}

// ─── Count Mode Helper ─────────────────────────────────────────

function parseCountMode(c: Context): "exact" | "estimated" {
  return c.req.query("exact_count") === "true" ? "exact" : "estimated";
}

// ─── H-5 + A-10: Institution Resolution Helpers (PR #105: exported) ─

/**
 * Determine if a parentKey connects to the content hierarchy.
 * Returns true for "institution_id" (direct) or any key in PARENT_KEY_TO_TABLE.
 * Returns false for unknown keys like "study_plan_id".
 */
export function isContentHierarchyParent(parentKey: string): boolean {
  return parentKey === "institution_id" || parentKey in PARENT_KEY_TO_TABLE;
}

async function resolveInstitutionFromParent(
  db: any,
  parentKey: string,
  parentValue: string,
): Promise<string | null> {
  if (parentKey === "institution_id") return parentValue;

  const parentTable = PARENT_KEY_TO_TABLE[parentKey];
  if (!parentTable) return null;

  try {
    const { data, error } = await db.rpc("resolve_parent_institution", {
      p_table: parentTable,
      p_id: parentValue,
    });
    if (error || !data) return null;
    return data as string;
  } catch {
    return null;
  }
}

async function resolveInstitutionFromRow(
  db: any,
  table: string,
  rowId: string,
): Promise<string | null> {
  try {
    const { data, error } = await db.rpc("resolve_parent_institution", {
      p_table: table,
      p_id: rowId,
    });
    if (error || !data) return null;
    return data as string;
  } catch {
    return null;
  }
}

async function checkContentScope(
  c: Context,
  db: any,
  userId: string,
  cfg: CrudConfig,
  opts: {
    parentValue?: string;
    rowId?: string;
    isWrite: boolean;
  },
): Promise<Response | null> {
  if (cfg.scopeToUser || !cfg.parentKey) return null;
  if (!isContentHierarchyParent(cfg.parentKey)) return null;

  let institutionId: string | null = null;

  if (opts.parentValue) {
    institutionId = await resolveInstitutionFromParent(db, cfg.parentKey, opts.parentValue);
  } else if (opts.rowId) {
    institutionId = await resolveInstitutionFromRow(db, cfg.table, opts.rowId);
  }

  if (!institutionId) {
    return err(c, "Cannot resolve institution for this resource", 404);
  }

  const allowedRoles = opts.isWrite ? CONTENT_WRITE_ROLES : ALL_ROLES;
  const roleCheck = await requireInstitutionRole(db, userId, institutionId, allowedRoles);
  if (isDenied(roleCheck)) {
    return err(c, roleCheck.message, roleCheck.status);
  }

  return null;
}

// ─── Factory ─────────────────────────────────────────────────────

export function registerCrud(app: Hono, cfg: CrudConfig) {
  const base = `${PREFIX}/${cfg.slug}`;

  const isActiveSoftDelete = cfg.softDelete && cfg.hasIsActive !== false;

  // ── LIST ──────────────────────────────────────────────────
  app.get(base, async (c: Context) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    const countMode = parseCountMode(c);
    let query = db.from(cfg.table).select("*", { count: countMode });

    let parentValue: string | undefined;
    if (cfg.parentKey) {
      parentValue = c.req.query(cfg.parentKey);
      if (!parentValue) {
        return err(c, `Missing required query param: ${cfg.parentKey}`, 400);
      }
      query = query.eq(cfg.parentKey, parentValue);
    }

    const scopeErr = await checkContentScope(c, db, user.id, cfg, {
      parentValue,
      isWrite: false,
    });
    if (scopeErr) return scopeErr;

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

  // ── GET BY ID ─────────────────────────────────────────────
  app.get(`${base}/:id`, async (c: Context) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    const id = c.req.param("id");

    const scopeErr = await checkContentScope(c, db, user.id, cfg, {
      rowId: id,
      isWrite: false,
    });
    if (scopeErr) return scopeErr;

    let query = db.from(cfg.table).select("*").eq("id", id);

    if (cfg.scopeToUser) {
      query = query.eq(cfg.scopeToUser, user.id);
    }

    const { data, error } = await query.single();
    if (error)
      return err(c, `Get ${cfg.table} ${id} failed: ${error.message}`, 404);
    return ok(c, data);
  });

  // ── CREATE ────────────────────────────────────────────────
  app.post(base, async (c: Context) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    const body = await safeJson(c);
    if (!body) return err(c, "Invalid or missing JSON body", 400);
    const row: Record<string, unknown> = {};

    let parentValue: string | undefined;
    if (cfg.parentKey) {
      if (!body[cfg.parentKey]) {
        return err(c, `Missing required field: ${cfg.parentKey}`, 400);
      }
      parentValue = body[cfg.parentKey] as string;
      row[cfg.parentKey] = parentValue;
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

    const scopeErr = await checkContentScope(c, db, user.id, cfg, {
      parentValue,
      isWrite: true,
    });
    if (scopeErr) return scopeErr;

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

    if (cfg.afterWrite) {
      try {
        cfg.afterWrite({ action: "create", row: data, userId: user.id });
      } catch (hookErr) {
        console.warn(
          `[CRUD Hook] afterWrite threw on ${cfg.table} create:`,
          (hookErr as Error).message,
        );
      }
    }

    return ok(c, data, 201);
  });

  // ── UPDATE ────────────────────────────────────────────────
  app.put(`${base}/:id`, async (c: Context) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    const id = c.req.param("id");

    const scopeErr = await checkContentScope(c, db, user.id, cfg, {
      rowId: id,
      isWrite: true,
    });
    if (scopeErr) return scopeErr;

    const body = await safeJson(c);
    if (!body) return err(c, "Invalid or missing JSON body", 400);
    const row: Record<string, unknown> = {};

    for (const f of cfg.updateFields) {
      if (body[f] !== undefined) row[f] = body[f];
    }

    if (Object.keys(row).length === 0) {
      return err(c, "No valid fields to update", 400);
    }

    const updatedFields = Object.keys(row);

    if (cfg.hasUpdatedAt) row.updated_at = new Date().toISOString();

    let query = db.from(cfg.table).update(row).eq("id", id);
    if (cfg.scopeToUser) query = query.eq(cfg.scopeToUser, user.id);

    const { data, error } = await query.select().single();
    if (error)
      return err(c, `Update ${cfg.table} ${id} failed: ${error.message}`, 500);

    if (cfg.afterWrite) {
      try {
        cfg.afterWrite({ action: "update", row: data, updatedFields, userId: user.id });
      } catch (hookErr) {
        console.warn(
          `[CRUD Hook] afterWrite threw on ${cfg.table} update:`,
          (hookErr as Error).message,
        );
      }
    }

    return ok(c, data);
  });

  // ── DELETE ────────────────────────────────────────────────
  app.delete(`${base}/:id`, async (c: Context) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    const id = c.req.param("id");

    const scopeErr = await checkContentScope(c, db, user.id, cfg, {
      rowId: id,
      isWrite: true,
    });
    if (scopeErr) return scopeErr;

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

      const scopeErr = await checkContentScope(c, db, user.id, cfg, {
        rowId: id,
        isWrite: true,
      });
      if (scopeErr) return scopeErr;

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

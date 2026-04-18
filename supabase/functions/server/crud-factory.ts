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
 *          Clients can opt-in to exact count via ?exact_count=true.
 *
 * H-5 FIX: Institution scoping added to all 6 endpoint types.
 *   - READ ops (LIST, GET): requireInstitutionRole(ALL_ROLES)
 *   - WRITE ops (POST, PUT, DELETE, RESTORE): requireInstitutionRole(CONTENT_WRITE_ROLES)
 *   - Skipped for scopeToUser tables (student data, already user-scoped)
 *   - courses (parentKey=institution_id): shortcut, no RPC needed
 *   - All other tables: resolve via resolve_parent_institution() RPC
 *
 * A-10 FIX: Institution scoping only applies to KNOWN content-hierarchy
 *   parentKeys. Tables with parentKeys not in the mapping (e.g.
 *   study_plan_tasks → study_plan_id) are not part of the content
 *   hierarchy and are skipped. This prevents false 404s on tables
 *   whose parents are user-scoped or otherwise outside the hierarchy.
 *
 * A-2 FIX: POST endpoint validates requiredFields BEFORE calling
 *   checkContentScope, avoiding unnecessary RPC calls on invalid bodies.
 */

import { Hono } from "npm:hono";
import { authenticate, ok, err, safeJson, PREFIX } from "./db.ts";
import { safeErr } from "./lib/safe-error.ts";
import { isUuid } from "./validate.ts";
import {
  requireInstitutionRole,
  isDenied,
  ALL_ROLES,
  CONTENT_WRITE_ROLES,
} from "./auth-helpers.ts";
import { resolveInstitutionViaRpc } from "./lib/institution-resolver.ts";
import type { Context } from "npm:hono";

// ─── Constants ────────────────────────────────────────────────────

const MAX_PAGINATION_LIMIT = 500;
const DEFAULT_PAGINATION_LIMIT = 100;

// ─── H-5 + A-10: Parent key to table mapping ─────────────────────
// Maps FK column names to their parent table for institution resolution.
// "institution_id" is handled as a special case (direct, no RPC needed).
//
// IMPORTANT: Only parentKeys that connect to the content hierarchy
// (courses → subtopics) are listed here. ParentKeys for non-content
// tables (e.g. study_plan_id) are intentionally excluded — those tables
// are either user-scoped or don't have a clean FK path to institution_id.

const PARENT_KEY_TO_TABLE: Record<string, string> = {
  course_id: "courses",
  semester_id: "semesters",
  section_id: "sections",
  topic_id: "topics",
  summary_id: "summaries",
  keyword_id: "keywords",
  model_id: "models_3d",    // A-10 FIX: model_3d_pins → models_3d → topics → ... → courses
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

  /** Task 7.5: Columns to SELECT on LIST instead of "*". Excludes heavy columns from list views. */
  listFields?: string;

  /** Task 9.1: Child tables to cascade soft-delete to. */
  cascadeChildren?: { table: string; fk: string }[];

  /**
   * Optional lifecycle hook called after successful POST or PUT.
   *
   * Invoked synchronously (fire-and-forget) — the factory does NOT
   * await the hook. If the hook starts async work (e.g. embedding
   * generation), it manages its own error handling via .catch().
   *
   * The HTTP response is NEVER delayed by this hook.
   * NOT called on DELETE or RESTORE operations.
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
// S-1 FIX: Use "estimated" count by default to avoid full table scans.

function parseCountMode(c: Context): "exact" | "estimated" {
  return c.req.query("exact_count") === "true" ? "exact" : "estimated";
}

// ─── H-5 + A-10: Institution Resolution Helpers ──────────────────

/**
 * Determine if a parentKey connects to the content hierarchy.
 * Returns true for "institution_id" (direct) or any key in PARENT_KEY_TO_TABLE.
 * Returns false for unknown keys like "study_plan_id".
 */
function isContentHierarchyParent(parentKey: string): boolean {
  return parentKey === "institution_id" || parentKey in PARENT_KEY_TO_TABLE;
}

/**
 * Resolve institution_id from a parent FK key + value.
 * For "institution_id": returns the value directly (it IS the institution).
 * For others: calls resolve_parent_institution RPC.
 */
async function resolveInstitutionFromParent(
  db: any,
  parentKey: string,
  parentValue: string,
): Promise<string | null> {
  if (parentKey === "institution_id") return parentValue;

  const parentTable = PARENT_KEY_TO_TABLE[parentKey];
  if (!parentTable) return null; // Unknown parent key → fail-closed

  return resolveInstitutionViaRpc(db, parentTable, parentValue);
}

/**
 * Resolve institution_id from a row's own table + ID.
 * Used for GET/PUT/DELETE/RESTORE where we don't have the parent value.
 */
async function resolveInstitutionFromRow(
  db: any,
  table: string,
  rowId: string,
): Promise<string | null> {
  return resolveInstitutionViaRpc(db, table, rowId);
}

/**
 * Check institution scoping for a content operation.
 * Returns Response (error) if denied, or null if access is granted.
 *
 * Skips the check entirely when:
 *   - cfg.scopeToUser is set (student data, already user-scoped)
 *   - cfg.parentKey is absent (no parent, top-level table)
 *   - cfg.parentKey is NOT in the content hierarchy mapping (A-10 fix:
 *     tables like study_plan_tasks whose parent is user-scoped)
 */
async function checkContentScope(
  c: Context,
  db: any,
  userId: string,
  cfg: CrudConfig,
  opts: {
    parentValue?: string; // For LIST/POST: the parent FK value
    rowId?: string;       // For GET/PUT/DELETE/RESTORE: the row's own ID
    isWrite: boolean;     // true = CONTENT_WRITE_ROLES, false = ALL_ROLES
  },
): Promise<Response | null> {
  // Skip for user-scoped tables or tables without a parent
  if (cfg.scopeToUser || !cfg.parentKey) return null;

  // A-10 FIX: Only apply institution scoping to known content-hierarchy parents.
  // Tables with parentKeys NOT in the mapping (e.g. study_plan_id → study_plans)
  // are not part of the content hierarchy and don't have a clean FK path to
  // institution_id. Skipping is safe because their parents are user-scoped.
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

  return null; // Access granted
}

// ─── Factory ───────────────────────────────────────────────────

export function registerCrud(app: Hono, cfg: CrudConfig) {
  const base = `${PREFIX}/${cfg.slug}`;

  const isActiveSoftDelete = cfg.softDelete && cfg.hasIsActive !== false;

  // ── LIST ──────────────────────────────────────────────────
  app.get(base, async (c: Context) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    const countMode = parseCountMode(c);
    let query = db.from(cfg.table).select(cfg.listFields || "*", { count: countMode });

    let parentValue: string | undefined;
    if (cfg.parentKey) {
      parentValue = c.req.query(cfg.parentKey);
      if (!parentValue) {
        return err(c, `Missing required query param: ${cfg.parentKey}`, 400);
      }
      query = query.eq(cfg.parentKey, parentValue);
    }

    // H-5 FIX: Verify caller has membership in this resource's institution
    const scopeErr = await checkContentScope(c, db, user.id, cfg, {
      parentValue,
      isWrite: false,
    });
    if (scopeErr) return scopeErr;

    if (cfg.optionalFilters) {
      for (const f of cfg.optionalFilters) {
        const v = c.req.query(f);
        if (v) {
          if (f.endsWith("_id") && !isUuid(v)) {
            return err(c, `${f} must be a valid UUID`, 400);
          }
          query = query.eq(f, v);
        }
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
    if (error) return safeErr(c, `List ${cfg.table}`, error);
    return ok(c, { items: data, total: count, limit, offset });
  });

  // ── GET BY ID ─────────────────────────────────────────────
  app.get(`${base}/:id`, async (c: Context) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    const id = c.req.param("id");

    // H-5 FIX: Verify caller has membership in this resource's institution
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
      return safeErr(c, `Get ${cfg.table}`, error, 404);
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

    // A-2 FIX: Validate required fields BEFORE institution check.
    // Avoids unnecessary RPC call when body is incomplete.
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

    // H-5 FIX: Verify caller has write access in this resource's institution
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
      return safeErr(c, `Create ${cfg.table}`, error);

    // Fase 5: Fire-and-forget afterWrite hook (e.g. auto-ingest for summaries).
    // Wrapped in try/catch to absorb synchronous exceptions from hook setup.
    // The HTTP response is NEVER delayed or affected by hook failures.
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

    // H-5 FIX: Verify caller has write access in this resource's institution
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

    // Capture which fields the client actually sent BEFORE appending updated_at.
    // Used by afterWrite hooks to decide whether to trigger side effects
    // (e.g. only re-chunk summaries when content_markdown changed).
    const updatedFields = Object.keys(row);

    if (cfg.hasUpdatedAt) row.updated_at = new Date().toISOString();

    let query = db.from(cfg.table).update(row).eq("id", id);
    if (cfg.scopeToUser) query = query.eq(cfg.scopeToUser, user.id);

    const { data, error } = await query.select().single();
    if (error)
      return safeErr(c, `Update ${cfg.table}`, error);

    // Fase 5: Fire-and-forget afterWrite hook.
    // updatedFields reflects ONLY what the client sent (not updated_at).
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

    // H-5 FIX: Verify caller has write access in this resource's institution
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
        return safeErr(c, `Soft-delete ${cfg.table}`, error);

      // Task 9.1: Cascade soft-delete to child tables (fire-and-forget)
      if (cfg.cascadeChildren && cfg.cascadeChildren.length > 0) {
        const now = new Date().toISOString();
        for (const child of cfg.cascadeChildren) {
          db.from(child.table)
            .update({ deleted_at: now, is_active: false, updated_at: now })
            .eq(child.fk, id)
            .is("deleted_at", null)
            .then(({ error: cascadeErr }: { error: { message: string } | null }) => {
              if (cascadeErr) {
                console.warn(`[CRUD Cascade] ${cfg.table} → ${child.table}: ${cascadeErr.message}`);
              }
            });
        }
      }

      return ok(c, data);
    } else {
      let query = db.from(cfg.table).delete().eq("id", id);
      if (cfg.scopeToUser) query = query.eq(cfg.scopeToUser, user.id);

      const { error } = await query;
      if (error)
        return safeErr(c, `Delete ${cfg.table}`, error);
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

      // H-5 FIX: Verify caller has write access in this resource's institution
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
        return safeErr(c, `Restore ${cfg.table}`, error);
      return ok(c, data);
    });
  }
}

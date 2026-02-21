/**
 * routes-content.tsx — Content hierarchy CRUD for Axon v4.4
 *
 * Covers: courses, semesters, sections, topics, summaries,
 *         chunks, keywords, subtopics, keyword_connections, kw_prof_notes
 *
 * All routes are authenticated. Uses user-scoped Supabase client (RLS).
 * Sacred tables use soft-delete (deleted_at). Non-sacred use hard delete.
 * Authorization (role checks) is enforced by RLS policies on the database.
 *
 * Portable: only PREFIX changes between Figma Make and production.
 */

import { Hono } from "npm:hono";
import { authenticate, ok, err, safeJson, PREFIX } from "./db.ts";
import { registerCrud } from "./crud-factory.ts";
import type { Context } from "npm:hono";

const content = new Hono();

// ─── Helpers (content-specific) ───────────────────────────────────────

/**
 * Run async tasks in batches to avoid overwhelming the connection pool.
 * Returns all settled results in order.
 */
async function parallelBatch<T>(
  tasks: (() => Promise<T>)[],
  batchSize = 20,
): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < tasks.length; i += batchSize) {
    const batch = tasks.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map((fn) => fn()));
    results.push(...batchResults);
  }
  return results;
}

/**
 * Recursively filter inactive nodes from the content tree.
 * PostgREST's `.eq("is_active", true)` only filters the top-level table;
 * nested embeds return ALL children regardless. This fixes that in JS.
 */
function filterActiveTree(courses: Record<string, unknown>[]): Record<string, unknown>[] {
  if (!courses) return [];
  return courses
    .filter((c) => c.is_active !== false)
    .map((c) => ({
      ...c,
      semesters: !Array.isArray(c.semesters)
        ? []
        : (c.semesters as Record<string, unknown>[])
            .filter((s) => s.is_active !== false)
            .map((s) => ({
              ...s,
              sections: !Array.isArray(s.sections)
                ? []
                : (s.sections as Record<string, unknown>[])
                    .filter((sec) => sec.is_active !== false)
                    .map((sec) => ({
                      ...sec,
                      topics: !Array.isArray(sec.topics)
                        ? []
                        : (sec.topics as Record<string, unknown>[]).filter(
                            (t) => t.is_active !== false,
                          ),
                    })),
            })),
    }));
}

// ─── Register Content CRUD ──────────────────────────────────────────

// 1. Courses — Institution -> Course
registerCrud(content, {
  table: "courses",
  slug: "courses",
  parentKey: "institution_id",
  hasCreatedBy: true,
  hasUpdatedAt: true,
  hasOrderIndex: true,
  requiredFields: ["name"],
  createFields: ["name", "description", "order_index"],
  updateFields: ["name", "description", "order_index", "is_active"],
});

// 2. Semesters — Course -> Semester
registerCrud(content, {
  table: "semesters",
  slug: "semesters",
  parentKey: "course_id",
  hasCreatedBy: true,
  hasUpdatedAt: true,
  hasOrderIndex: true,
  requiredFields: ["name"],
  createFields: ["name", "order_index"],
  updateFields: ["name", "order_index", "is_active"],
});

// 3. Sections — Semester -> Section
registerCrud(content, {
  table: "sections",
  slug: "sections",
  parentKey: "semester_id",
  hasCreatedBy: true,
  hasUpdatedAt: true,
  hasOrderIndex: true,
  requiredFields: ["name"],
  createFields: ["name", "order_index"],
  updateFields: ["name", "order_index", "is_active"],
});

// 4. Topics — Section -> Topic
registerCrud(content, {
  table: "topics",
  slug: "topics",
  parentKey: "section_id",
  hasCreatedBy: true,
  hasUpdatedAt: true,
  hasOrderIndex: true,
  requiredFields: ["name"],
  createFields: ["name", "order_index"],
  updateFields: ["name", "order_index", "is_active"],
});

// 5. Summaries — Topic -> Summary (SACRED, soft-delete)
registerCrud(content, {
  table: "summaries",
  slug: "summaries",
  parentKey: "topic_id",
  hasCreatedBy: true,
  hasUpdatedAt: true,
  hasOrderIndex: true,
  softDelete: true,
  requiredFields: ["title"],
  createFields: ["title", "content_markdown", "status", "order_index"],
  updateFields: [
    "title",
    "content_markdown",
    "status",
    "order_index",
    "is_active",
  ],
});

// 6. Chunks — Summary -> Chunk (NO updated_at, NO created_by, NO is_active)
registerCrud(content, {
  table: "chunks",
  slug: "chunks",
  parentKey: "summary_id",
  hasCreatedBy: false,
  hasUpdatedAt: false,
  hasOrderIndex: true,
  requiredFields: ["content"],
  createFields: ["content", "order_index", "metadata"],
  updateFields: ["content", "order_index", "metadata"],
});

// 7. Keywords — Summary -> Keyword (SACRED, soft-delete)
registerCrud(content, {
  table: "keywords",
  slug: "keywords",
  parentKey: "summary_id",
  hasCreatedBy: true,
  hasUpdatedAt: true,
  hasOrderIndex: false,
  softDelete: true,
  requiredFields: ["name"],
  createFields: ["name", "definition", "priority"],
  updateFields: ["name", "definition", "priority", "is_active"],
});

// 8. Subtopics — Keyword -> Subtopic (SACRED, soft-delete, NO updated_at)
registerCrud(content, {
  table: "subtopics",
  slug: "subtopics",
  parentKey: "keyword_id",
  hasCreatedBy: false,
  hasUpdatedAt: false,
  hasOrderIndex: true,
  softDelete: true,
  requiredFields: ["name"],
  createFields: ["name", "order_index"],
  updateFields: ["name", "order_index", "is_active"],
});

// ─── Keyword Connections (special: no update, canonical order) ─────────

const connBase = `${PREFIX}/keyword-connections`;

// LIST — get connections for a keyword (either side)
content.get(connBase, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const keywordId = c.req.query("keyword_id");
  if (!keywordId)
    return err(c, "Missing required query param: keyword_id", 400);

  const { data, error } = await db
    .from("keyword_connections")
    .select("*")
    .or(`keyword_a_id.eq.${keywordId},keyword_b_id.eq.${keywordId}`)
    .order("created_at", { ascending: true });

  if (error)
    return err(c, `List keyword_connections failed: ${error.message}`, 500);
  return ok(c, data);
});

// GET by ID
content.get(`${connBase}/:id`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const id = c.req.param("id");
  const { data, error } = await db
    .from("keyword_connections")
    .select("*")
    .eq("id", id)
    .single();
  if (error)
    return err(
      c,
      `Get keyword_connection ${id} failed: ${error.message}`,
      404,
    );
  return ok(c, data);
});

// CREATE — enforces canonical order (a < b)
content.post(connBase, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const keyword_a_id = body.keyword_a_id;
  const keyword_b_id = body.keyword_b_id;
  const relationship = body.relationship;

  if (typeof keyword_a_id !== "string" || typeof keyword_b_id !== "string") {
    return err(c, "keyword_a_id and keyword_b_id must be strings", 400);
  }
  if (keyword_a_id === keyword_b_id) {
    return err(c, "Cannot connect a keyword to itself", 400);
  }

  // Enforce canonical order: a < b (the DB CHECK constraint also enforces this)
  const [a, b] =
    keyword_a_id < keyword_b_id
      ? [keyword_a_id, keyword_b_id]
      : [keyword_b_id, keyword_a_id];

  const { data, error } = await db
    .from("keyword_connections")
    .insert({
      keyword_a_id: a,
      keyword_b_id: b,
      relationship: typeof relationship === "string" ? relationship : null,
    })
    .select()
    .single();

  if (error)
    return err(
      c,
      `Create keyword_connection failed: ${error.message}`,
      500,
    );
  return ok(c, data, 201);
});

// DELETE — hard delete (not sacred)
content.delete(`${connBase}/:id`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const id = c.req.param("id");
  const { error } = await db
    .from("keyword_connections")
    .delete()
    .eq("id", id);
  if (error)
    return err(
      c,
      `Delete keyword_connection ${id} failed: ${error.message}`,
      500,
    );
  return ok(c, { deleted: id });
});

// ─── Professor Notes on Keywords ──────────────────────────────────────

const profNotesBase = `${PREFIX}/kw-prof-notes`;

// LIST — notes for a keyword (all professors' notes visible)
content.get(profNotesBase, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const keywordId = c.req.query("keyword_id");
  if (!keywordId)
    return err(c, "Missing required query param: keyword_id", 400);

  const { data, error } = await db
    .from("kw_prof_notes")
    .select("*")
    .eq("keyword_id", keywordId)
    .order("created_at", { ascending: true });

  if (error)
    return err(c, `List kw_prof_notes failed: ${error.message}`, 500);
  return ok(c, data);
});

// GET by ID
content.get(`${profNotesBase}/:id`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const id = c.req.param("id");
  const { data, error } = await db
    .from("kw_prof_notes")
    .select("*")
    .eq("id", id)
    .single();
  if (error)
    return err(c, `Get kw_prof_note ${id} failed: ${error.message}`, 404);
  return ok(c, data);
});

// CREATE / UPSERT — one note per professor per keyword (UNIQUE constraint)
content.post(profNotesBase, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const keyword_id = body.keyword_id;
  const note = body.note;

  if (typeof keyword_id !== "string" || typeof note !== "string") {
    return err(c, "keyword_id and note must be non-empty strings", 400);
  }

  const { data, error } = await db
    .from("kw_prof_notes")
    .upsert(
      {
        professor_id: user.id,
        keyword_id,
        note,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "professor_id,keyword_id" },
    )
    .select()
    .single();

  if (error)
    return err(c, `Upsert kw_prof_note failed: ${error.message}`, 500);
  return ok(c, data, 201);
});

// DELETE
content.delete(`${profNotesBase}/:id`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const id = c.req.param("id");
  const { error } = await db.from("kw_prof_notes").delete().eq("id", id);
  if (error)
    return err(
      c,
      `Delete kw_prof_note ${id} failed: ${error.message}`,
      500,
    );
  return ok(c, { deleted: id });
});

// ─── Bulk Reorder ─────────────────────────────────────────────────────
// PUT /reorder  body: { table: "courses", items: [{ id, order_index }] }

const MAX_REORDER_ITEMS = 200;

// Tables that have updated_at (for reorder patch)
const tablesWithUpdatedAt = new Set([
  "courses",
  "semesters",
  "sections",
  "topics",
  "summaries",
  "videos",
  "models_3d",
  "model_3d_pins",
]);

const allowedReorderTables = [
  "courses",
  "semesters",
  "sections",
  "topics",
  "summaries",
  "chunks",
  "subtopics",
  "videos",
  "models_3d",
  "model_3d_pins",
  "study_plan_tasks",
];

content.put(`${PREFIX}/reorder`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const table = body.table;
  const items = body.items;

  if (typeof table !== "string" || !allowedReorderTables.includes(table)) {
    return err(c, `Reorder not allowed for table: ${table}`, 400);
  }

  if (!Array.isArray(items) || items.length === 0) {
    return err(
      c,
      "items must be a non-empty array of { id, order_index }",
      400,
    );
  }

  if (items.length > MAX_REORDER_ITEMS) {
    return err(
      c,
      `Too many items: ${items.length} (max ${MAX_REORDER_ITEMS})`,
      400,
    );
  }

  // Validate every item's shape and types upfront (catches "5" as string)
  const invalid = items.filter((i: unknown) => {
    if (!i || typeof i !== "object") return true;
    const item = i as Record<string, unknown>;
    return (
      typeof item.id !== "string" ||
      typeof item.order_index !== "number" ||
      !Number.isFinite(item.order_index)
    );
  });
  if (invalid.length > 0) {
    return err(
      c,
      `Invalid items (each needs id:string, order_index:number): ${JSON.stringify(invalid)}`,
      400,
    );
  }

  // At this point, items are validated
  const typedItems = items as Array<{ id: string; order_index: number }>;

  const hasUpdatedAt = tablesWithUpdatedAt.has(table);
  const now = new Date().toISOString();

  // Build parallel update tasks (NOT upsert — upsert fails with NOT NULL on missing columns)
  // Phase 3 backlog: replace with a single RPC call to a PostgreSQL function:
  //   CREATE FUNCTION bulk_reorder(p_table text, p_items jsonb) RETURNS void AS $$
  //     UPDATE target SET order_index = (i->>'order_index')::int, updated_at = now()
  //     FROM jsonb_array_elements(p_items) i WHERE t.id = (i->>'id')::uuid;
  //   $$ LANGUAGE sql SECURITY DEFINER;
  const tasks = typedItems.map((item) => () => {
    const patch: Record<string, unknown> = { order_index: item.order_index };
    if (hasUpdatedAt) patch.updated_at = now;
    return db.from(table).update(patch).eq("id", item.id);
  });

  const results = await parallelBatch(tasks, 20);
  const errors = results
    .filter((r: { error: unknown }) => r.error)
    .map((r: { error: { message: string } }) => r.error.message);

  if (errors.length > 0) {
    return err(
      c,
      `Reorder partial failure (${errors.length}/${typedItems.length}): ${errors.join("; ")}`,
      500,
    );
  }

  return ok(c, { reordered: typedItems.length });
});

// ─── Content Tree (nested hierarchy in one call) ──────────────────────
// GET /content-tree?institution_id=xxx
// Returns: courses -> semesters -> sections -> topics (lightweight, no summaries)
// Phase 3 backlog: replace with a single RPC call to a PostgreSQL function
// that builds the filtered tree via jsonb_agg, eliminating the bandwidth tax
// of fetching inactive nodes just to discard them in JS.

content.get(`${PREFIX}/content-tree`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const institutionId = c.req.query("institution_id");
  if (!institutionId)
    return err(c, "Missing required query param: institution_id", 400);

  const { data, error } = await db
    .from("courses")
    .select(
      `
      id, name, description, order_index, is_active,
      semesters (
        id, name, order_index, is_active,
        sections (
          id, name, order_index, is_active,
          topics (
            id, name, order_index, is_active
          )
        )
      )
    `,
    )
    .eq("institution_id", institutionId)
    .eq("is_active", true)
    .order("order_index", { ascending: true })
    .order("order_index", { ascending: true, referencedTable: "semesters" })
    .order("order_index", {
      ascending: true,
      referencedTable: "semesters.sections",
    })
    .order("order_index", {
      ascending: true,
      referencedTable: "semesters.sections.topics",
    });

  if (error) return err(c, `Content tree failed: ${error.message}`, 500);
  return ok(c, filterActiveTree(data ?? []));
});

export { content };

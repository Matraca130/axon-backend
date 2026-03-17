/**
 * routes/models/index.ts — 3D Models CRUD + batch for Axon v4.4
 *
 * CRUD factory entities:
 *   models_3d       — professor-created 3D models per topic
 *   model_3d_pins   — interactive pins on models
 *   model_3d_notes  — student personal notes on models
 *   model_layers    — grouping layers for model parts
 *   model_parts     — individual meshes/parts of a model
 *
 * Custom endpoints:
 *   GET /models-3d/batch — batch-fetch models for multiple topics
 *
 * PR #105: Extracted from routes-models.ts.
 *   Upload endpoint moved to ./upload.ts.
 */

import { Hono } from "npm:hono";
import { registerCrud } from "../../crud-factory.ts";
import { authenticate, ok, err, PREFIX } from "../../db.ts";
import {
  requireInstitutionRole,
  isDenied,
  ALL_ROLES,
} from "../../auth-helpers.ts";
import type { Context } from "npm:hono";
import { uploadRoutes } from "./upload.ts";

const modelRoutes = new Hono();

// ═════════════════════════════════════════════════════════════════
// ── Custom: GET /models-3d/batch (H2 audit fix) ───────────────
// ═════════════════════════════════════════════════════════════════

modelRoutes.get(`${PREFIX}/models-3d/batch`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const raw = c.req.query("topic_ids") || "";
  const topicIds = raw.split(",").map((s) => s.trim()).filter(Boolean);

  if (topicIds.length === 0) {
    return err(c, "Missing or empty topic_ids query parameter", 400);
  }
  if (topicIds.length > 200) {
    return err(c, "Maximum 200 topic_ids per batch request", 400);
  }

  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const invalidIds = topicIds.filter((id) => !uuidRegex.test(id));
  if (invalidIds.length > 0) {
    return err(
      c,
      `Invalid UUID format: ${invalidIds.slice(0, 3).join(", ")}`,
      400,
    );
  }

  try {
    const { data: instData, error: instErr } = await db.rpc(
      "resolve_parent_institution",
      { p_table: "topics", p_id: topicIds[0] },
    );
    if (instErr || !instData) {
      return err(c, "Cannot resolve institution for this resource", 404);
    }
    const roleCheck = await requireInstitutionRole(
      db,
      user.id,
      instData as string,
      ALL_ROLES,
    );
    if (isDenied(roleCheck)) {
      return err(c, roleCheck.message, roleCheck.status);
    }
  } catch {
    return err(c, "Institution scoping check failed", 500);
  }

  const { data: models, error: dbErr } = await db
    .from("models_3d")
    .select("*")
    .in("topic_id", topicIds)
    .eq("is_active", true)
    .is("deleted_at", null)
    .order("order_index", { ascending: true });

  if (dbErr) {
    return err(c, `Database error: ${dbErr.message}`, 500);
  }

  const grouped: Record<string, typeof models> = {};
  for (const tid of topicIds) {
    grouped[tid] = [];
  }
  for (const model of models || []) {
    const tid = model.topic_id as string;
    if (grouped[tid]) {
      grouped[tid].push(model);
    }
  }

  return ok(c, grouped);
});

// ═════════════════════════════════════════════════════════════════
// ── CRUD Factory Entities ─────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════

registerCrud(modelRoutes, {
  table: "models_3d",
  slug: "models-3d",
  parentKey: "topic_id",
  hasCreatedBy: true,
  hasUpdatedAt: true,
  hasOrderIndex: true,
  softDelete: true,
  hasIsActive: true,
  requiredFields: ["title", "file_url"],
  createFields: [
    "title",
    "file_url",
    "file_format",
    "thumbnail_url",
    "file_size_bytes",
    "order_index",
  ],
  updateFields: [
    "title",
    "file_url",
    "file_format",
    "thumbnail_url",
    "file_size_bytes",
    "order_index",
    "is_active",
  ],
});

registerCrud(modelRoutes, {
  table: "model_3d_pins",
  slug: "model-3d-pins",
  parentKey: "model_id",
  optionalFilters: ["keyword_id"],
  hasCreatedBy: true,
  hasUpdatedAt: true,
  hasOrderIndex: true,
  requiredFields: ["geometry"],
  createFields: [
    "keyword_id",
    "pin_type",
    "geometry",
    "normal",
    "title",
    "color",
    "description",
    "order_index",
  ],
  updateFields: [
    "keyword_id",
    "pin_type",
    "geometry",
    "normal",
    "title",
    "color",
    "description",
    "order_index",
  ],
});

registerCrud(modelRoutes, {
  table: "model_3d_notes",
  slug: "model-3d-notes",
  parentKey: "model_id",
  scopeToUser: "student_id",
  hasCreatedBy: false,
  hasUpdatedAt: true,
  hasOrderIndex: false,
  softDelete: true,
  hasIsActive: false,
  requiredFields: ["note"],
  createFields: ["geometry", "note"],
  updateFields: ["geometry", "note"],
});

registerCrud(modelRoutes, {
  table: "model_layers",
  slug: "model-layers",
  parentKey: "model_id",
  hasCreatedBy: false,
  hasUpdatedAt: true,
  hasOrderIndex: true,
  requiredFields: ["name"],
  createFields: ["name", "color_hex", "order_index"],
  updateFields: ["name", "color_hex", "order_index"],
});

registerCrud(modelRoutes, {
  table: "model_parts",
  slug: "model-parts",
  parentKey: "model_id",
  hasCreatedBy: false,
  hasUpdatedAt: true,
  hasOrderIndex: true,
  requiredFields: ["name"],
  createFields: [
    "name",
    "layer_group",
    "file_url",
    "color_hex",
    "opacity_default",
    "is_visible_default",
    "order_index",
  ],
  updateFields: [
    "name",
    "layer_group",
    "file_url",
    "color_hex",
    "opacity_default",
    "is_visible_default",
    "order_index",
  ],
});

// ═════════════════════════════════════════════════════════════════
// ── Mount Upload Sub-module ───────────────────────────────────────
// ═════════════════════════════════════════════════════════════════

modelRoutes.route("/", uploadRoutes);

export { modelRoutes };

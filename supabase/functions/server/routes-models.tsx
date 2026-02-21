/**
 * routes-models.tsx — 3D Models, Pins & Student Notes for Axon v4.4
 *
 * All via CRUD factory:
 *   models_3d       — professor-created 3D models per topic (SACRED, soft-delete)
 *   model_3d_pins   — interactive pins on models (professor-created)
 *   model_3d_notes  — student personal notes on models (scopeToUser, soft-delete)
 */

import { Hono } from "npm:hono";
import { registerCrud } from "./crud-factory.ts";

const modelRoutes = new Hono();

// 1. Models 3D — Topic -> Model3D (SACRED, soft-delete, orderable)
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

// 2. Model 3D Pins — Model -> Pin (professor-created, orderable, hard delete)
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
    "label",
    "color",
    "description",
    "order_index",
  ],
  updateFields: [
    "keyword_id",
    "pin_type",
    "geometry",
    "normal",
    "label",
    "color",
    "description",
    "order_index",
  ],
});

// 3. Model 3D Notes — student personal notes on models
//    Has deleted_at but NO is_active column.
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

export { modelRoutes };

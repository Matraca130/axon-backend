/**
 * routes-models.ts — 3D Models, Pins, Notes, Layers, Parts & Upload for Axon v4.4
 *
 * CRUD factory entities:
 *   models_3d       — professor-created 3D models per topic (SACRED, soft-delete)
 *   model_3d_pins   — interactive pins on models (professor-created)
 *   model_3d_notes  — student personal notes on models (scopeToUser, soft-delete)
 *   model_layers    — grouping layers for model parts (hard delete)
 *   model_parts     — individual meshes/parts of a model (hard delete)
 *
 * Custom endpoints:
 *   GET  /models-3d/batch   — batch-fetch models for multiple topics (H2 perf fix)
 *   POST /upload-model-3d   — multipart file upload for .glb/.gltf to Supabase Storage
 */

import { Hono } from "npm:hono";
import { registerCrud } from "./crud-factory.ts";
import { authenticate, ok, err, PREFIX, getAdminClient } from "./db.ts";
import { safeErr } from "./lib/safe-error.ts";
import {
  requireInstitutionRole,
  isDenied,
  ALL_ROLES,
} from "./auth-helpers.ts";
import { resolveInstitutionViaRpc } from "./lib/institution-resolver.ts";
import type { Context } from "npm:hono";

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
    const instData = await resolveInstitutionViaRpc(db, "topics", topicIds[0]);
    if (!instData) {
      return err(c, "Cannot resolve institution for this resource", 404);
    }
    const roleCheck = await requireInstitutionRole(
      db,
      user.id,
      instData,
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
    return safeErr(c, "Model upload", dbErr);
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
  createFields: [
    "name",
    "color_hex",
    "order_index",
  ],
  updateFields: [
    "name",
    "color_hex",
    "order_index",
  ],
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
// ── Custom: POST /upload-model-3d ─────────────────────────────────
// ═════════════════════════════════════════════════════════════════

const MODEL_BUCKET = "axon-models-3d";
const MAX_MODEL_SIZE = 100 * 1024 * 1024;
const ALLOWED_MODEL_EXTENSIONS = [".glb", ".gltf"];
const GLB_MAGIC = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);

let modelBucketReady = false;

async function ensureModelBucket(): Promise<void> {
  if (modelBucketReady) return;
  const admin = getAdminClient();
  const { data: buckets } = await admin.storage.listBuckets();
  const exists = buckets?.some((b: { name: string }) => b.name === MODEL_BUCKET);
  if (!exists) {
    const { error: createErr } = await admin.storage.createBucket(MODEL_BUCKET, {
      public: true,
      fileSizeLimit: MAX_MODEL_SIZE,
    });
    if (createErr) {
      console.error(`[Models3D] Failed to create bucket: ${createErr.message}`);
      throw createErr;
    }
    console.warn(`[Models3D] Created bucket: ${MODEL_BUCKET}`);
  }
  modelBucketReady = true;
}

modelRoutes.post(`${PREFIX}/upload-model-3d`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user } = auth;

  const contentType = c.req.header("Content-Type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return err(c, "Expected multipart/form-data", 400);
  }

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch (e) {
    return safeErr(c, "Parse form data", e instanceof Error ? e : null, 400);
  }

  const file = formData.get("file") as File | null;
  if (!file) {
    return err(c, "Missing 'file' field in form data", 400);
  }

  const fileName = file.name.toLowerCase();
  const ext = fileName.substring(fileName.lastIndexOf("."));
  if (!ALLOWED_MODEL_EXTENSIONS.includes(ext)) {
    return err(
      c,
      `Invalid format: "${ext}". Allowed: ${ALLOWED_MODEL_EXTENSIONS.join(", ")}`,
      400,
    );
  }

  if (file.size > MAX_MODEL_SIZE) {
    return err(
      c,
      `File too large: ${file.size} bytes. Maximum: ${MAX_MODEL_SIZE} bytes (100MB)`,
      400,
    );
  }

  if (ext === ".glb") {
    try {
      const header = new Uint8Array(await file.slice(0, 4).arrayBuffer());
      const isValid = GLB_MAGIC.every((b, i) => header[i] === b);
      if (!isValid) {
        return err(c, "Invalid GLB file (bad magic bytes)", 400);
      }
    } catch {
      // Skip check if header read fails
    }
  }

  try {
    await ensureModelBucket();
  } catch (e) {
    return safeErr(c, "Storage initialization", e instanceof Error ? e : null);
  }

  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  const sanitized = fileName
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .substring(0, 60);
  const storagePath = `models/${user.id}/${timestamp}-${random}-${sanitized}`;

  const admin = getAdminClient();
  const fileBuffer = await file.arrayBuffer();

  const { error: uploadError } = await admin.storage
    .from(MODEL_BUCKET)
    .upload(storagePath, fileBuffer, {
      contentType: ext === ".glb" ? "model/gltf-binary" : "model/gltf+json",
      upsert: false,
    });

  if (uploadError) {
    return safeErr(c, "Model upload", uploadError);
  }

  const { data: urlData } = admin.storage
    .from(MODEL_BUCKET)
    .getPublicUrl(storagePath);

  console.warn(
    `[Models3D] Uploaded: ${storagePath} (${file.size} bytes) by user ${user.id}`,
  );

  return ok(
    c,
    {
      file_url: urlData.publicUrl,
      file_size_bytes: file.size,
      file_format: ext.replace(".", ""),
    },
    201,
  );
});

export { modelRoutes };

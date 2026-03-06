/**
 * routes-models.tsx — 3D Models, Pins, Notes, Layers, Parts & Upload for Axon v4.4
 *
 * CRUD factory entities:
 *   models_3d       — professor-created 3D models per topic (SACRED, soft-delete)
 *   model_3d_pins   — interactive pins on models (professor-created)
 *   model_3d_notes  — student personal notes on models (scopeToUser, soft-delete)
 *   model_layers    — grouping layers for model parts (hard delete)
 *   model_parts     — individual meshes/parts of a model (hard delete)
 *
 * Custom endpoint:
 *   POST /upload-model-3d — multipart file upload for .glb/.gltf to Supabase Storage
 */

import { Hono } from "npm:hono";
import { registerCrud } from "./crud-factory.ts";
import { authenticate, ok, err, PREFIX, getAdminClient } from "./db.ts";
import type { Context } from "npm:hono";

const modelRoutes = new Hono();

// ═══════════════════════════════════════════════════════════════
// ── CRUD Factory Entities ─────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

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
//    NOTE: DB column is "title" (not "label"). Verified in schema-3d-ai.md.
//    Frontend sends { title: "..." } — must match createFields/updateFields.
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

// 4. Model Layers — Grouping layers for model parts (e.g. "Skeletal System")
//    No soft-delete, no created_by, no is_active. Hard delete.
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

// 5. Model Parts — Individual meshes that can be toggled/colored
//    No soft-delete, no created_by, no is_active. Hard delete.
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

// ═══════════════════════════════════════════════════════════════
// ── Custom: POST /upload-model-3d ─────────────────────────────
// ═══════════════════════════════════════════════════════════════
//
// Uploads .glb/.gltf files to Supabase Storage bucket "axon-models-3d".
// Validates extension, size (≤100MB), and GLB magic bytes.
// Returns { file_url, file_size_bytes, file_format }.
//
// The frontend calls this BEFORE POST /models-3d to get the file_url.
// Frontend code: model3d-api.ts → uploadAndCreateModel()

const MODEL_BUCKET = "axon-models-3d";
const MAX_MODEL_SIZE = 100 * 1024 * 1024; // 100 MB
const ALLOWED_MODEL_EXTENSIONS = [".glb", ".gltf"];
const GLB_MAGIC = new Uint8Array([0x67, 0x6c, 0x54, 0x46]); // "glTF"

let modelBucketReady = false;

async function ensureModelBucket(): Promise<void> {
  if (modelBucketReady) return;
  const admin = getAdminClient();
  const { data: buckets } = await admin.storage.listBuckets();
  const exists = buckets?.some((b: { name: string }) => b.name === MODEL_BUCKET);
  if (!exists) {
    const { error: createErr } = await admin.storage.createBucket(MODEL_BUCKET, {
      public: true, // GLB files need to be publicly fetchable by Three.js
      fileSizeLimit: MAX_MODEL_SIZE,
    });
    if (createErr) {
      console.error(`[Models3D] Failed to create bucket: ${createErr.message}`);
      throw createErr;
    }
    console.log(`[Models3D] Created bucket: ${MODEL_BUCKET}`);
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
    return err(c, `Failed to parse form data: ${(e as Error).message}`, 400);
  }

  const file = formData.get("file") as File | null;
  if (!file) {
    return err(c, "Missing 'file' field in form data", 400);
  }

  // Validate extension
  const fileName = file.name.toLowerCase();
  const ext = fileName.substring(fileName.lastIndexOf("."));
  if (!ALLOWED_MODEL_EXTENSIONS.includes(ext)) {
    return err(
      c,
      `Invalid format: "${ext}". Allowed: ${ALLOWED_MODEL_EXTENSIONS.join(", ")}`,
      400,
    );
  }

  // Validate size
  if (file.size > MAX_MODEL_SIZE) {
    return err(
      c,
      `File too large: ${file.size} bytes. Maximum: ${MAX_MODEL_SIZE} bytes (100MB)`,
      400,
    );
  }

  // Validate GLB magic bytes
  if (ext === ".glb") {
    try {
      const header = new Uint8Array(await file.slice(0, 4).arrayBuffer());
      const isValid = GLB_MAGIC.every((b, i) => header[i] === b);
      if (!isValid) {
        return err(c, "Invalid GLB file (bad magic bytes)", 400);
      }
    } catch {
      // If header read fails, skip check (Edge Function env may behave differently)
    }
  }

  // Ensure bucket exists
  try {
    await ensureModelBucket();
  } catch (e) {
    return err(c, `Storage initialization failed: ${(e as Error).message}`, 500);
  }

  // Generate unique storage path
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  const sanitized = fileName
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .substring(0, 60);
  const storagePath = `models/${user.id}/${timestamp}-${random}-${sanitized}`;

  // Upload to Supabase Storage
  const admin = getAdminClient();
  const fileBuffer = await file.arrayBuffer();

  const { error: uploadError } = await admin.storage
    .from(MODEL_BUCKET)
    .upload(storagePath, fileBuffer, {
      contentType: ext === ".glb" ? "model/gltf-binary" : "model/gltf+json",
      upsert: false,
    });

  if (uploadError) {
    return err(c, `Upload failed: ${uploadError.message}`, 500);
  }

  // Get public URL (bucket is public)
  const { data: urlData } = admin.storage
    .from(MODEL_BUCKET)
    .getPublicUrl(storagePath);

  console.log(
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

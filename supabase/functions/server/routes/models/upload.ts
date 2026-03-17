/**
 * routes/models/upload.ts — 3D model file upload for Axon v4.4
 *
 * POST /upload-model-3d — Multipart file upload for .glb/.gltf
 *   - Validates file extension and magic bytes (GLB)
 *   - Uploads to Supabase Storage bucket
 *   - Returns public URL
 *
 * Extracted from routes-models.ts (PR #105) for maintainability.
 */

import { Hono } from "npm:hono";
import { authenticate, ok, err, PREFIX, getAdminClient } from "../../db.ts";
import type { Context } from "npm:hono";

export const uploadRoutes = new Hono();

// ─── Constants ──────────────────────────────────────────────────────

const MODEL_BUCKET = "axon-models-3d";
const MAX_MODEL_SIZE = 100 * 1024 * 1024;
const ALLOWED_MODEL_EXTENSIONS = [".glb", ".gltf"];
const GLB_MAGIC = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);

let modelBucketReady = false;

// Known tech debt: TOCTOU race — two concurrent requests can both see the
// bucket as missing (listBuckets → check → createBucket) and race to create
// it. In practice this is harmless because Supabase's createBucket returns an
// error for duplicates and the modelBucketReady flag prevents further calls,
// but a proper fix would use a mutex or an idempotent upsert.
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
    console.log(`[Models3D] Created bucket: ${MODEL_BUCKET}`);
  }
  modelBucketReady = true;
}

// ─── POST /upload-model-3d ──────────────────────────────────────────

uploadRoutes.post(`${PREFIX}/upload-model-3d`, async (c: Context) => {
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
    return err(c, `Storage initialization failed: ${(e as Error).message}`, 500);
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
    return err(c, `Upload failed: ${uploadError.message}`, 500);
  }

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

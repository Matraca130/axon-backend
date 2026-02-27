/**
 * routes-storage.tsx — File storage routes for Axon v4.4
 *
 * Handles image upload/retrieval/deletion for flashcards and summaries
 * using Supabase Storage.
 *
 * Routes:
 *   POST   /storage/upload      — Upload an image file (multipart or base64 JSON)
 *   POST   /storage/signed-url  — Get signed URL(s) for existing file(s)
 *   DELETE /storage/delete      — Delete file(s) from storage
 *
 * Bucket: axon-images (private, auto-created on first use)
 * Path pattern: {folder}/{userId}/{timestamp}-{random}.{ext}
 * Folders: flashcards, summaries, general
 *
 * Limits: 5MB max, image/jpeg|png|webp|gif only
 * Signed URLs expire after 1 hour.
 *
 * O-2 FIX: signed-url and delete routes now use safeJson() instead of raw c.req.json().
 * O-6 FIX: base64 upload wraps atob() in try/catch.
 */

import { Hono } from "npm:hono";
import { authenticate, ok, err, safeJson, PREFIX, getAdminClient } from "./db.ts";
import type { Context } from "npm:hono";

const storageRoutes = new Hono();

// ─── Constants ────────────────────────────────────────────────────────

const BUCKET_NAME = "axon-images";
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];
const SIGNED_URL_EXPIRY = 3600; // 1 hour in seconds
const VALID_FOLDERS = ["flashcards", "summaries", "general"];

// ─── Bucket Init (idempotent, cached after first success) ─────────────

let bucketReady = false;

async function ensureBucket(): Promise<void> {
  if (bucketReady) return;
  const admin = getAdminClient();
  const { data: buckets } = await admin.storage.listBuckets();
  const exists = buckets?.some((b: { name: string }) => b.name === BUCKET_NAME);
  if (!exists) {
    const { error } = await admin.storage.createBucket(BUCKET_NAME, {
      public: false,
      fileSizeLimit: MAX_FILE_SIZE,
      allowedMimeTypes: ALLOWED_MIME_TYPES,
    });
    if (error) {
      console.error(`[Storage] Failed to create bucket: ${error.message}`);
      throw error;
    }
    console.log(`[Storage] Created bucket: ${BUCKET_NAME}`);
  }
  bucketReady = true;
}

// ─── POST /storage/upload ─────────────────────────────────────────

storageRoutes.post(`${PREFIX}/storage/upload`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user } = auth;

  try {
    await ensureBucket();
  } catch (e) {
    return err(c, `Storage initialization failed: ${(e as Error).message}`, 500);
  }

  const contentType = c.req.header("Content-Type") || "";
  let fileBuffer: ArrayBuffer;
  let mimeType: string;
  let folder: string;
  let originalName: string;

  if (contentType.includes("multipart/form-data")) {
    // ── Multipart upload ────────────────────────────────────────
    const formData = await c.req.formData();
    const file = formData.get("file") as File | null;
    folder = (formData.get("folder") as string) || "general";

    if (!file) {
      return err(c, "Missing 'file' field in form data", 400);
    }
    if (!ALLOWED_MIME_TYPES.includes(file.type)) {
      return err(
        c,
        `Invalid file type: ${file.type}. Allowed: ${ALLOWED_MIME_TYPES.join(", ")}`,
        400,
      );
    }
    if (file.size > MAX_FILE_SIZE) {
      return err(
        c,
        `File too large: ${file.size} bytes. Max: ${MAX_FILE_SIZE} bytes (5MB)`,
        400,
      );
    }

    fileBuffer = await file.arrayBuffer();
    mimeType = file.type;
    originalName = file.name;
  } else if (contentType.includes("application/json")) {
    // ── Base64 JSON upload (fallback) ───────────────────────────
    const body = await c.req.json();
    if (!body.base64 || !body.mimeType || !body.fileName) {
      return err(c, "JSON upload requires: base64, mimeType, fileName", 400);
    }
    if (!ALLOWED_MIME_TYPES.includes(body.mimeType)) {
      return err(
        c,
        `Invalid file type: ${body.mimeType}. Allowed: ${ALLOWED_MIME_TYPES.join(", ")}`,
        400,
      );
    }

    // O-6 FIX: Wrap atob() in try/catch for invalid base64 input
    let binaryString: string;
    try {
      binaryString = atob(body.base64);
    } catch {
      return err(c, "Invalid base64 data", 400);
    }

    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    if (bytes.length > MAX_FILE_SIZE) {
      return err(
        c,
        `File too large: ${bytes.length} bytes. Max: ${MAX_FILE_SIZE} bytes (5MB)`,
        400,
      );
    }

    fileBuffer = bytes.buffer;
    mimeType = body.mimeType;
    folder = body.folder || "general";
    originalName = body.fileName;
  } else {
    return err(
      c,
      "Unsupported Content-Type. Use multipart/form-data or application/json",
      400,
    );
  }

  // Sanitize folder
  if (!VALID_FOLDERS.includes(folder)) {
    folder = "general";
  }

  // Generate unique storage path
  const ext = originalName.split(".").pop() || "jpg";
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  const storagePath = `${folder}/${user.id}/${timestamp}-${random}.${ext}`;

  // Upload via admin client (bypasses RLS)
  const admin = getAdminClient();
  const { error: uploadError } = await admin.storage
    .from(BUCKET_NAME)
    .upload(storagePath, fileBuffer, {
      contentType: mimeType,
      upsert: false,
    });

  if (uploadError) {
    return err(c, `Upload failed: ${uploadError.message}`, 500);
  }

  // Generate signed URL for immediate use
  const { data: signedData, error: signedError } = await admin.storage
    .from(BUCKET_NAME)
    .createSignedUrl(storagePath, SIGNED_URL_EXPIRY);

  if (signedError) {
    return err(
      c,
      `Upload succeeded but signed URL generation failed: ${signedError.message}`,
      500,
    );
  }

  console.log(`[Storage] Uploaded: ${storagePath} by user ${user.id}`);

  return ok(
    c,
    {
      path: storagePath,
      signedUrl: signedData.signedUrl,
      expiresIn: SIGNED_URL_EXPIRY,
    },
    201,
  );
});

// ─── POST /storage/signed-url ─────────────────────────────────────
// O-2 FIX: Uses safeJson() instead of raw c.req.json()

storageRoutes.post(`${PREFIX}/storage/signed-url`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const admin = getAdminClient();

  // ── Batch mode ──────────────────────────────────────────────
  if (body.paths && Array.isArray(body.paths)) {
    if (body.paths.length === 0) {
      return ok(c, { signedUrls: [], expiresIn: SIGNED_URL_EXPIRY });
    }

    const { data, error } = await admin.storage
      .from(BUCKET_NAME)
      .createSignedUrls(body.paths, SIGNED_URL_EXPIRY);

    if (error) {
      return err(c, `Batch signed URL failed: ${error.message}`, 500);
    }

    return ok(c, { signedUrls: data, expiresIn: SIGNED_URL_EXPIRY });
  }

  // ── Single mode ─────────────────────────────────────────────
  if (!body.path) {
    return err(c, "Missing 'path' or 'paths' in request body", 400);
  }

  const { data, error } = await admin.storage
    .from(BUCKET_NAME)
    .createSignedUrl(body.path, SIGNED_URL_EXPIRY);

  if (error) {
    return err(c, `Signed URL failed: ${error.message}`, 500);
  }

  return ok(c, {
    path: body.path,
    signedUrl: data.signedUrl,
    expiresIn: SIGNED_URL_EXPIRY,
  });
});

// ─── DELETE /storage/delete ───────────────────────────────────────
// O-2 FIX: Uses safeJson() instead of raw c.req.json()

storageRoutes.delete(`${PREFIX}/storage/delete`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const admin = getAdminClient();

  const paths: string[] = body.paths || (body.path ? [body.path] : []);
  if (paths.length === 0) {
    return err(c, "Missing 'path' or 'paths' in request body", 400);
  }

  // Security: only allow deleting files owned by the authenticated user
  const unauthorized = paths.filter(
    (p: string) => !p.includes(`/${user.id}/`),
  );
  if (unauthorized.length > 0) {
    return err(
      c,
      `Cannot delete files owned by another user. Unauthorized paths: ${unauthorized.join(", ")}`,
      403,
    );
  }

  const { error } = await admin.storage.from(BUCKET_NAME).remove(paths);

  if (error) {
    return err(c, `Delete failed: ${error.message}`, 500);
  }

  console.log(
    `[Storage] Deleted ${paths.length} file(s) by user ${user.id}`,
  );
  return ok(c, { deleted: paths });
});

export { storageRoutes };

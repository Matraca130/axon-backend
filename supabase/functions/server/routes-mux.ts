// ============================================================
// routes-mux.ts — Mux Video Integration (EV-9)
//
// Routes:
//   POST   /mux/create-upload      — direct upload to Mux, INSERT videos row
//   POST   /webhooks/mux           — asset.ready / asset.errored webhook
//   GET    /mux/playback-token     — signed JWT for playback (?video_id=xxx)
//   POST   /mux/track-view         — UPSERT video_views, BKT/FSRS signal
//   GET    /mux/video-stats        — aggregated stats for professor (?video_id=xxx)
//   DELETE /mux/asset/:video_id    — delete from Mux + soft-delete in DB
//
// ENV VARS required:
//   MUX_TOKEN_ID, MUX_TOKEN_SECRET
//   MUX_WEBHOOK_SECRET
//   MUX_SIGNING_KEY_ID, MUX_SIGNING_KEY_SECRET
// ============================================================

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { PREFIX, authenticate, safeJson, ok, err, getAdminClient } from "./db.ts";

// ─── Mux Config ───────────────────────────────────────────────────────
const MUX_TOKEN_ID          = Deno.env.get("MUX_TOKEN_ID") ?? "";
const MUX_TOKEN_SECRET      = Deno.env.get("MUX_TOKEN_SECRET") ?? "";
const MUX_WEBHOOK_SECRET    = Deno.env.get("MUX_WEBHOOK_SECRET") ?? "";
const MUX_SIGNING_KEY_ID    = Deno.env.get("MUX_SIGNING_KEY_ID") ?? "";
const MUX_SIGNING_KEY_SECRET = Deno.env.get("MUX_SIGNING_KEY_SECRET") ?? "";

const MUX_BASE = "https://api.mux.com";
const muxAuth  = `Basic ${btoa(`${MUX_TOKEN_ID}:${MUX_TOKEN_SECRET}`)}`;

export const muxRoutes = new Hono();

// ─── Helpers ──────────────────────────────────────────────────────────

/** Call Mux REST API */
async function muxFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  return fetch(`${MUX_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: muxAuth,
      ...(options.headers ?? {}),
    },
  });
}

/** Verify Mux webhook signature (HMAC-SHA256) */
async function verifyMuxWebhook(
  body: string,
  signature: string | null,
): Promise<boolean> {
  if (!signature || !MUX_WEBHOOK_SECRET) return false;
  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(MUX_WEBHOOK_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    // Mux sends: "t=<timestamp>,v1=<hex-sig>"
    const parts = Object.fromEntries(
      signature.split(",").map((p) => p.split("=")),
    );
    const timestamp = parts["t"];
    const v1 = parts["v1"];
    if (!timestamp || !v1) return false;

    const signedPayload = `${timestamp}.${body}`;
    const sigBytes = new Uint8Array(
      v1.match(/.{2}/g)!.map((b) => parseInt(b, 16)),
    );
    return await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes,
      encoder.encode(signedPayload),
    );
  } catch {
    return false;
  }
}

/** Build a signed Mux playback JWT (RS256) */
async function buildPlaybackJwt(playbackId: string): Promise<string> {
  // Decode base64 PEM private key stored in env
  const pemBody = atob(MUX_SIGNING_KEY_SECRET);

  const binaryDer = Uint8Array.from(atob(MUX_SIGNING_KEY_SECRET), (c) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    binaryDer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const header = { alg: "RS256", typ: "JWT", kid: MUX_SIGNING_KEY_ID };
  const payload = {
    sub: playbackId,
    aud: "v",
    exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour
    kid: MUX_SIGNING_KEY_ID,
  };

  const encode = (obj: unknown) =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

  const headerB64  = encode(header);
  const payloadB64 = encode(payload);
  const signingInput = `${headerB64}.${payloadB64}`;

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput),
  );

  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return `${signingInput}.${sigB64}`;
}

// ─── Route 1: POST /mux/create-upload ─────────────────────────────────
// Creates a Mux direct upload URL + inserts a pending videos row.
// Body: { summary_id, title }
// Returns: { video_id, upload_url }

muxRoutes.post(`${PREFIX}/mux/create-upload`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const { summary_id, title } = body;
  if (typeof summary_id !== "string" || typeof title !== "string") {
    return err(c, "summary_id and title are required strings", 400);
  }

  // 1. Create Mux direct upload
  const muxRes = await muxFetch("/video/v1/uploads", {
    method: "POST",
    body: JSON.stringify({
      cors_origin: "*",
      new_asset_settings: {
        playback_policy: ["signed"],
        mp4_support: 'capped-1080p',
      },
    }),
  });

  if (!muxRes.ok) {
    const muxErr = await muxRes.text();
    return err(c, `Mux create upload failed: ${muxErr}`, 502);
  }

  const muxData = await muxRes.json() as {
    data: { id: string; url: string };
  };
  const muxUploadId = muxData.data.id;
  const uploadUrl   = muxData.data.url;

  // 2. Insert pending videos row
  // NOTE: platform uses "other" because the CHECK constraint on videos.platform
  // only allows 'youtube','vimeo','other'. The is_mux=true flag distinguishes
  // Mux assets from other "other" platform videos.
  const { data: video, error: dbErr } = await db
    .from("videos")
    .insert({
      summary_id,
      title,
      url: "",                    // will be set after asset.ready
      platform: "other",          // CHECK constraint: youtube|vimeo|other
      order_index: 0,
      is_active: false,           // activate after ready
      created_by: user.id,
      is_mux: true,
      status: "uploading",
      mux_upload_id: muxUploadId,
    })
    .select("id")
    .single();

  if (dbErr) return err(c, `Insert video failed: ${dbErr.message}`, 500);

  return ok(c, { video_id: video.id, upload_url: uploadUrl }, 201);
});

// ─── Route 2: POST /webhooks/mux ──────────────────────────────────────
// Handles Mux webhook events. No auth — verified by HMAC signature.
// Events handled:
//   video.asset.ready   → UPDATE status/playback_id/duration/thumbnail
//   video.asset.errored → UPDATE status='errored'

muxRoutes.post(`${PREFIX}/webhooks/mux`, async (c: Context) => {
  const rawBody  = await c.req.text();
  const signature = c.req.header("mux-signature") ?? null;

  const valid = await verifyMuxWebhook(rawBody, signature);
  if (!valid) {
    return err(c, "Invalid Mux webhook signature", 401);
  }

  let event: {
    type: string;
    data: {
      id: string;
      upload_id?: string;
      playback_ids?: Array<{ id: string; policy: string }>;
      duration?: number;
      aspect_ratio?: string;
      resolution_tier?: string;
      status?: string;
    };
  };

  try {
    event = JSON.parse(rawBody);
  } catch {
    return err(c, "Invalid JSON in webhook body", 400);
  }

  const admin = getAdminClient();

  if (event.type === "video.asset.ready") {
    const assetId    = event.data.id;
    const uploadId   = event.data.upload_id;
    const playbackId = event.data.playback_ids?.[0]?.id ?? null;
    const duration   = event.data.duration ? Math.round(event.data.duration) : null;
    const aspectRatio = event.data.aspect_ratio ?? null;
    // Use resolution_tier (e.g. "1080p") instead of deprecated max_stored_resolution
    const resTier    = event.data.resolution_tier ?? null;
    const thumbnail  = playbackId
      ? `https://image.mux.com/${playbackId}/thumbnail.jpg`
      : null;

    // Find video by mux_upload_id
    const { data: video } = await admin
      .from("videos")
      .select("id")
      .eq("mux_upload_id", uploadId ?? "")
      .single();

    if (video) {
      await admin
        .from("videos")
        .update({
          mux_asset_id:    assetId,
          mux_playback_id: playbackId,
          status:          "ready",
          is_active:       true,
          url:             playbackId
            ? `https://stream.mux.com/${playbackId}.m3u8`
            : "",
          duration_seconds: duration,
          thumbnail_url:   thumbnail,
          aspect_ratio:    aspectRatio,
          resolution_tier: resTier,
          updated_at:      new Date().toISOString(),
        })
        .eq("id", video.id);
    }
  } else if (event.type === "video.asset.errored") {
    const uploadId = event.data.upload_id;
    if (uploadId) {
      await admin
        .from("videos")
        .update({ status: "errored", updated_at: new Date().toISOString() })
        .eq("mux_upload_id", uploadId);
    }
  }

  return ok(c, { received: true });
});

// ─── Route 3: GET /mux/playback-token?video_id=xxx ────────────────────
// Returns a signed JWT for Mux signed playback.
// Requires: video must be ready + is_mux=true.

muxRoutes.get(`${PREFIX}/mux/playback-token`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const videoId = c.req.query("video_id");
  if (!videoId) return err(c, "Missing required query param: video_id", 400);

  const { data: video, error: dbErr } = await db
    .from("videos")
    .select("id, mux_playback_id, status, is_mux, deleted_at")
    .eq("id", videoId)
    .single();

  if (dbErr || !video) return err(c, "Video not found", 404);
  if (video.deleted_at)  return err(c, "Video has been deleted", 410);
  if (!video.is_mux)     return err(c, "Video is not a Mux asset", 400);
  if (video.status !== "ready") return err(c, `Video not ready (status: ${video.status})`, 409);
  if (!video.mux_playback_id)   return err(c, "Video has no playback ID", 500);

  try {
    const token = await buildPlaybackJwt(video.mux_playback_id);
    return ok(c, { token, playback_id: video.mux_playback_id });
  } catch (e) {
    return err(c, `Failed to build playback token: ${(e as Error).message}`, 500);
  }
});

// ─── Route 4: POST /mux/track-view ────────────────────────────────────
// UPSERT video_views. Fires BKT/FSRS signal when completed=true first time.
// Body: { video_id, institution_id, watch_time_seconds, total_watch_time_seconds,
//         completion_percentage, completed, last_position_seconds }

muxRoutes.post(`${PREFIX}/mux/track-view`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const {
    video_id,
    institution_id,
    watch_time_seconds = 0,
    total_watch_time_seconds = 0,
    completion_percentage = 0,
    completed = false,
    last_position_seconds = 0,
  } = body;

  if (typeof video_id !== "string" || typeof institution_id !== "string") {
    return err(c, "video_id and institution_id are required strings", 400);
  }

  // Check if this is the first completion (for BKT/FSRS signal)
  const { data: existing } = await db
    .from("video_views")
    .select("id, completed, view_count")
    .eq("video_id", video_id)
    .eq("user_id", user.id)
    .single();

  const isFirstCompletion = completed && !existing?.completed;
  const newViewCount = (existing?.view_count ?? 0) + 1;

  const { data: view, error: upsertErr } = await db
    .from("video_views")
    .upsert(
      {
        video_id,
        user_id: user.id,
        institution_id,
        watch_time_seconds,
        total_watch_time_seconds,
        completion_percentage,
        completed,
        last_position_seconds,
        view_count: newViewCount,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "video_id,user_id" },
    )
    .select()
    .single();

  if (upsertErr) return err(c, `Track view failed: ${upsertErr.message}`, 500);

  // BKT/FSRS signal: record reading event when video completed for first time
  // This mirrors the reading_states pattern used in SummarySession
  if (isFirstCompletion) {
    // Look up the video's summary_id for the reading_states signal
    const { data: videoRow } = await db
      .from("videos")
      .select("summary_id")
      .eq("id", video_id)
      .single();

    if (videoRow?.summary_id) {
      await db.from("reading_states").upsert(
        {
          student_id: user.id,
          summary_id: videoRow.summary_id,
          completed: true,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "student_id,summary_id" },
      ).maybeSingle(); // best-effort — don't fail track-view if this fails
    }
  }

  return ok(c, { ...view, first_completion: isFirstCompletion });
});

// ─── Route 5: GET /mux/video-stats?video_id=xxx ───────────────────────
// Aggregated watch stats for professor dashboard.

muxRoutes.get(`${PREFIX}/mux/video-stats`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const videoId = c.req.query("video_id");
  if (!videoId) return err(c, "Missing required query param: video_id", 400);

  const { data: views, error: dbErr } = await db
    .from("video_views")
    .select(
      "watch_time_seconds, total_watch_time_seconds, completion_percentage, completed, view_count",
    )
    .eq("video_id", videoId);

  if (dbErr) return err(c, `Fetch video stats failed: ${dbErr.message}`, 500);

  const totalViewers   = views?.length ?? 0;
  const completedCount = views?.filter((v) => v.completed).length ?? 0;
  const avgCompletion  = totalViewers > 0
    ? views!.reduce((s, v) => s + Number(v.completion_percentage), 0) / totalViewers
    : 0;
  const avgWatchTime   = totalViewers > 0
    ? views!.reduce((s, v) => s + Number(v.watch_time_seconds), 0) / totalViewers
    : 0;
  const totalViews     = views?.reduce((s, v) => s + (v.view_count ?? 1), 0) ?? 0;

  return ok(c, {
    video_id:          videoId,
    total_viewers:     totalViewers,
    total_views:       totalViews,
    completed_count:   completedCount,
    completion_rate:   totalViewers > 0
      ? Math.round((completedCount / totalViewers) * 100)
      : 0,
    avg_completion_pct: Math.round(avgCompletion),
    avg_watch_time_sec: Math.round(avgWatchTime),
  });
});

// ─── Route 6: DELETE /mux/asset/:video_id ─────────────────────────────
// Deletes Mux asset + soft-deletes the videos row.

muxRoutes.delete(`${PREFIX}/mux/asset/:video_id`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const videoId = c.req.param("video_id");

  // Fetch video to get mux_asset_id
  const { data: video, error: fetchErr } = await db
    .from("videos")
    .select("id, mux_asset_id, is_mux, deleted_at")
    .eq("id", videoId)
    .single();

  if (fetchErr || !video) return err(c, "Video not found", 404);
  if (video.deleted_at)  return err(c, "Video already deleted", 410);

  // Delete from Mux if it's a Mux asset
  if (video.is_mux && video.mux_asset_id) {
    const muxRes = await muxFetch(`/video/v1/assets/${video.mux_asset_id}`, {
      method: "DELETE",
    });
    // 404 from Mux = already gone, that's fine
    if (!muxRes.ok && muxRes.status !== 404) {
      const muxErr = await muxRes.text();
      return err(c, `Mux delete failed: ${muxErr}`, 502);
    }
  }

  // Soft-delete in DB
  const { error: dbErr } = await db
    .from("videos")
    .update({
      deleted_at: new Date().toISOString(),
      is_active: false,
      updated_at: new Date().toISOString(),
    })
    .eq("id", videoId);

  if (dbErr) return err(c, `Soft-delete video failed: ${dbErr.message}`, 500);

  return ok(c, { deleted: videoId });
});

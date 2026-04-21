/**
 * routes/mux/api.ts — Authenticated Mux API endpoints
 *
 * POST   /mux/create-upload      — Direct upload to Mux + INSERT videos row
 * GET    /mux/playback-token     — Signed JWT for playback
 * GET    /mux/video-stats        — Aggregated stats for professor
 * DELETE /mux/asset/:video_id    — Delete from Mux + soft-delete in DB
 *
 * W7-SEC02 FIX: All 4 endpoints now resolve institution ownership
 * via video→summary→resolve_parent_institution and verify membership
 * via requireInstitutionRole(). Previously, any authenticated user
 * could access/modify any video across all institutions.
 *
 * W7-SEC05 FIX: create-upload now resolves institution BEFORE calling
 * the Mux API, closing the JWT verification gap where a forged JWT
 * could consume a Mux upload URL before PostgREST validates it.
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { PREFIX, authenticate, safeJson, ok, err } from "../../db.ts";
import { safeErr } from "../../lib/safe-error.ts";
import { isUuid } from "../../validate.ts";
import {
  requireInstitutionRole,
  isDenied,
  ALL_ROLES,
  CONTENT_WRITE_ROLES,
} from "../../auth-helpers.ts";
import { muxFetch, buildPlaybackJwt } from "./helpers.ts";
import { resolveInstitutionViaRpc } from "../../lib/institution-resolver.ts";

export const muxApiRoutes = new Hono();

// ─── POST /mux/create-upload ─────────────────────────────────────
muxApiRoutes.post(`${PREFIX}/mux/create-upload`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const { summary_id, title } = body;
  if (!isUuid(summary_id)) return err(c, "summary_id must be a valid UUID", 400);
  if (typeof title !== "string" || !title.trim())
    return err(c, "title is required (non-empty string)", 400);

  // W7-SEC02 + W7-SEC05 FIX: Resolve institution BEFORE Mux API call.
  // This validates the JWT cryptographically via PostgREST and prevents
  // forged JWTs from consuming Mux upload URLs.
  const instId = await resolveInstitutionViaRpc(db, "summaries", summary_id);
  if (!instId) return err(c, "Summary not found or inaccessible", 404);

  const roleCheck = await requireInstitutionRole(
    db, user.id, instId, CONTENT_WRITE_ROLES,
  );
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status);

  const muxRes = await muxFetch("/video/v1/uploads", {
    method: "POST",
    body: JSON.stringify({
      cors_origin: Deno.env.get("FRONTEND_ORIGIN") ?? "*",
      new_asset_settings: { playback_policy: ["signed"], mp4_support: 'capped-1080p' },
    }),
  });

  if (!muxRes.ok) {
    const muxErr = await muxRes.text();
    return err(c, `Mux create upload failed: ${muxErr}`, 502);
  }

  const muxData = await muxRes.json() as { data: { id: string; url: string } };
  const muxUploadId = muxData.data.id;
  const uploadUrl   = muxData.data.url;

  const { data: video, error: dbErr } = await db.from("videos").insert({
    summary_id, title, url: "", platform: "other", order_index: 0,
    is_active: false, created_by: user.id, is_mux: true,
    status: "uploading", mux_upload_id: muxUploadId,
  }).select("id").single();

  if (dbErr) return safeErr(c, "Insert video", dbErr);
  return ok(c, { video_id: video.id, upload_url: uploadUrl }, 201);
});

// ─── GET /mux/playback-token ────────────────────────────────────
muxApiRoutes.get(`${PREFIX}/mux/playback-token`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const videoId = c.req.query("video_id");
  if (!isUuid(videoId)) return err(c, "video_id must be a valid UUID", 400);

  const { data: video, error: dbErr } = await db
    .from("videos").select("id, summary_id, mux_playback_id, status, is_mux, deleted_at")
    .eq("id", videoId).single();

  if (dbErr || !video) return err(c, "Video not found", 404);
  if (video.deleted_at)  return err(c, "Video has been deleted", 410);
  if (!video.is_mux)     return err(c, "Video is not a Mux asset", 400);
  if (video.status !== "ready") return err(c, `Video not ready (status: ${video.status})`, 409);
  if (!video.mux_playback_id)   return err(c, "Video has no playback ID", 500);

  // W7-SEC02 FIX: Verify user has access to this video's institution
  const instId = await resolveInstitutionViaRpc(db, "summaries", video.summary_id);
  if (!instId) return err(c, "Cannot resolve video institution", 404);

  const roleCheck = await requireInstitutionRole(
    db, user.id, instId, ALL_ROLES,
  );
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status);

  try {
    const [token, thumbnailToken, storyboardToken] = await Promise.all([
      buildPlaybackJwt(video.mux_playback_id, "v"),
      buildPlaybackJwt(video.mux_playback_id, "t"),
      buildPlaybackJwt(video.mux_playback_id, "s"),
    ]);
    return ok(c, { token, thumbnail_token: thumbnailToken, storyboard_token: storyboardToken, playback_id: video.mux_playback_id });
  } catch (e) {
    return safeErr(c, "Build playback token", e instanceof Error ? e : null);
  }
});

// ─── GET /mux/video-stats ───────────────────────────────────────
muxApiRoutes.get(`${PREFIX}/mux/video-stats`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const videoId = c.req.query("video_id");
  if (!isUuid(videoId)) return err(c, "video_id must be a valid UUID", 400);

  // W7-SEC02 FIX: Fetch video to get summary_id for institution scoping
  const { data: videoRow, error: videoErr } = await db
    .from("videos").select("id, summary_id")
    .eq("id", videoId).single();

  if (videoErr || !videoRow) return err(c, "Video not found", 404);

  const instId = await resolveInstitutionViaRpc(db, "summaries", videoRow.summary_id);
  if (!instId) return err(c, "Cannot resolve video institution", 404);

  // Professors+ can see stats
  const roleCheck = await requireInstitutionRole(
    db, user.id, instId, CONTENT_WRITE_ROLES,
  );
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status);

  const { data: views, error: dbErr } = await db
    .from("video_views")
    .select("watch_time_seconds, total_watch_time_seconds, completion_percentage, completed, view_count")
    .eq("video_id", videoId);

  if (dbErr) return safeErr(c, "Fetch video stats", dbErr);

  const totalViewers   = views?.length ?? 0;
  const completedCount = views?.filter((v: any) => v.completed).length ?? 0;
  const avgCompletion  = totalViewers > 0 ? views!.reduce((s: number, v: any) => s + Number(v.completion_percentage), 0) / totalViewers : 0;
  const avgWatchTime   = totalViewers > 0 ? views!.reduce((s: number, v: any) => s + Number(v.watch_time_seconds), 0) / totalViewers : 0;
  const totalViews     = views?.reduce((s: number, v: any) => s + (v.view_count ?? 1), 0) ?? 0;

  return ok(c, {
    video_id: videoId, total_viewers: totalViewers, total_views: totalViews,
    completed_count: completedCount,
    completion_rate: totalViewers > 0 ? Math.round((completedCount / totalViewers) * 100) : 0,
    avg_completion_pct: Math.round(avgCompletion),
    avg_watch_time_sec: Math.round(avgWatchTime),
  });
});

// ─── DELETE /mux/asset/:video_id ─────────────────────────────────
muxApiRoutes.delete(`${PREFIX}/mux/asset/:video_id`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const videoId = c.req.param("video_id");
  if (!isUuid(videoId)) return err(c, "video_id must be a valid UUID", 400);
  const { data: video, error: fetchErr } = await db
    .from("videos").select("id, summary_id, mux_asset_id, is_mux, deleted_at")
    .eq("id", videoId).single();

  if (fetchErr || !video) return err(c, "Video not found", 404);
  if (video.deleted_at) return err(c, "Video already deleted", 410);

  // W7-SEC02 FIX: Verify user has content-write access to this institution
  const instId = await resolveInstitutionViaRpc(db, "summaries", video.summary_id);
  if (!instId) return err(c, "Cannot resolve video institution", 404);

  const roleCheck = await requireInstitutionRole(
    db, user.id, instId, CONTENT_WRITE_ROLES,
  );
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status);

  if (video.is_mux && video.mux_asset_id) {
    const muxRes = await muxFetch(`/video/v1/assets/${video.mux_asset_id}`, { method: "DELETE" });
    if (!muxRes.ok && muxRes.status !== 404) {
      const muxErr = await muxRes.text();
      return err(c, `Mux delete failed: ${muxErr}`, 502);
    }
  }

  const { error: dbErr } = await db.from("videos").update({
    deleted_at: new Date().toISOString(), is_active: false, updated_at: new Date().toISOString(),
  }).eq("id", videoId);

  if (dbErr) return safeErr(c, "Soft-delete video", dbErr);
  return ok(c, { deleted: videoId });
});

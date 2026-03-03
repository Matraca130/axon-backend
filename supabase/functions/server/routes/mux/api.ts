/**
 * routes/mux/api.ts — Authenticated Mux API endpoints
 *
 * POST   /mux/create-upload      — Direct upload to Mux + INSERT videos row
 * GET    /mux/playback-token     — Signed JWT for playback
 * GET    /mux/video-stats        — Aggregated stats for professor
 * DELETE /mux/asset/:video_id    — Delete from Mux + soft-delete in DB
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { PREFIX, authenticate, safeJson, ok, err } from "../../db.ts";
import { muxFetch, buildPlaybackJwt } from "./helpers.ts";

export const muxApiRoutes = new Hono();

// ─── POST /mux/create-upload ─────────────────────────────────────
muxApiRoutes.post(`${PREFIX}/mux/create-upload`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const { summary_id, title } = body;
  if (typeof summary_id !== "string" || typeof title !== "string")
    return err(c, "summary_id and title are required strings", 400);

  const muxRes = await muxFetch("/video/v1/uploads", {
    method: "POST",
    body: JSON.stringify({
      cors_origin: "*",
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

  if (dbErr) return err(c, `Insert video failed: ${dbErr.message}`, 500);
  return ok(c, { video_id: video.id, upload_url: uploadUrl }, 201);
});

// ─── GET /mux/playback-token ────────────────────────────────────
muxApiRoutes.get(`${PREFIX}/mux/playback-token`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const videoId = c.req.query("video_id");
  if (!videoId) return err(c, "Missing required query param: video_id", 400);

  const { data: video, error: dbErr } = await db
    .from("videos").select("id, mux_playback_id, status, is_mux, deleted_at")
    .eq("id", videoId).single();

  if (dbErr || !video) return err(c, "Video not found", 404);
  if (video.deleted_at)  return err(c, "Video has been deleted", 410);
  if (!video.is_mux)     return err(c, "Video is not a Mux asset", 400);
  if (video.status !== "ready") return err(c, `Video not ready (status: ${video.status})`, 409);
  if (!video.mux_playback_id)   return err(c, "Video has no playback ID", 500);

  try {
    const [token, thumbnailToken, storyboardToken] = await Promise.all([
      buildPlaybackJwt(video.mux_playback_id, "v"),
      buildPlaybackJwt(video.mux_playback_id, "t"),
      buildPlaybackJwt(video.mux_playback_id, "s"),
    ]);
    return ok(c, { token, thumbnail_token: thumbnailToken, storyboard_token: storyboardToken, playback_id: video.mux_playback_id });
  } catch (e) {
    return err(c, `Failed to build playback token: ${(e as Error).message}`, 500);
  }
});

// ─── GET /mux/video-stats ───────────────────────────────────────
muxApiRoutes.get(`${PREFIX}/mux/video-stats`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const videoId = c.req.query("video_id");
  if (!videoId) return err(c, "Missing required query param: video_id", 400);

  const { data: views, error: dbErr } = await db
    .from("video_views")
    .select("watch_time_seconds, total_watch_time_seconds, completion_percentage, completed, view_count")
    .eq("video_id", videoId);

  if (dbErr) return err(c, `Fetch video stats failed: ${dbErr.message}`, 500);

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
  const { db } = auth;

  const videoId = c.req.param("video_id");
  const { data: video, error: fetchErr } = await db
    .from("videos").select("id, mux_asset_id, is_mux, deleted_at")
    .eq("id", videoId).single();

  if (fetchErr || !video) return err(c, "Video not found", 404);
  if (video.deleted_at) return err(c, "Video already deleted", 410);

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

  if (dbErr) return err(c, `Soft-delete video failed: ${dbErr.message}`, 500);
  return ok(c, { deleted: videoId });
});

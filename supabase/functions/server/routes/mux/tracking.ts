/**
 * routes/mux/tracking.ts — Video view tracking
 *
 * POST /mux/track-view — UPSERT video_views, BKT/FSRS signal on first completion.
 * N-7 FIX: Uses upsert_video_view() DB function for atomic view_count.
 * Fallback: old read+write pattern if migration not yet applied.
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { PREFIX, authenticate, safeJson, ok, err } from "../../db.ts";
import { fireFirstCompletionSignal } from "./helpers.ts";

export const muxTrackingRoutes = new Hono();

muxTrackingRoutes.post(`${PREFIX}/mux/track-view`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const {
    video_id, institution_id,
    watch_time_seconds = 0, total_watch_time_seconds = 0,
    completion_percentage = 0, completed = false, last_position_seconds = 0,
  } = body;

  if (typeof video_id !== "string" || typeof institution_id !== "string")
    return err(c, "video_id and institution_id are required strings", 400);

  // ── Primary: atomic DB function (N-7 FIX) ──
  const { data: rpcData, error: rpcError } = await db.rpc("upsert_video_view", {
    p_video_id: video_id, p_user_id: user.id, p_institution_id: institution_id,
    p_watch_time_seconds: watch_time_seconds,
    p_total_watch_time_seconds: total_watch_time_seconds,
    p_completion_percentage: completion_percentage,
    p_completed: completed, p_last_position_seconds: last_position_seconds,
  });

  if (!rpcError && rpcData) {
    const view = rpcData.view;
    const isFirstCompletion = rpcData.first_completion;
    if (isFirstCompletion) await fireFirstCompletionSignal(db, user.id, video_id);
    return ok(c, { ...view, first_completion: isFirstCompletion });
  }

  // ── Fallback: old read+write pattern ──
  console.warn(`[mux/track-view] upsert_video_view RPC failed, using fallback: ${rpcError?.message}`);

  const { data: existing } = await db
    .from("video_views").select("id, completed, view_count")
    .eq("video_id", video_id).eq("user_id", user.id).single();

  const isFirstCompletion = completed && !existing?.completed;
  const newViewCount = (existing?.view_count ?? 0) + 1;

  const { data: view, error: upsertErr } = await db.from("video_views").upsert({
    video_id, user_id: user.id, institution_id,
    watch_time_seconds, total_watch_time_seconds, completion_percentage,
    completed, last_position_seconds, view_count: newViewCount,
    updated_at: new Date().toISOString(),
  }, { onConflict: "video_id,user_id" }).select().single();

  if (upsertErr) return err(c, `Track view failed: ${upsertErr.message}`, 500);
  if (isFirstCompletion) await fireFirstCompletionSignal(db, user.id, video_id);
  return ok(c, { ...view, first_completion: isFirstCompletion });
});

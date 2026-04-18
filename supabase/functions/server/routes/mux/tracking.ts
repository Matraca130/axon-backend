/**
 * routes/mux/tracking.ts — Video view tracking
 *
 * POST /mux/track-view — UPSERT video_views, BKT/FSRS signal on first completion.
 * N-7 FIX: Uses upsert_video_view() DB function for atomic view_count.
 * Fallback: old read+write pattern if migration not yet applied.
 *
 * W7-SEC03 FIX: institution_id is no longer accepted from the request body.
 * It is resolved server-side from video→summary→resolve_parent_institution.
 * This prevents an attacker from associating view data with arbitrary
 * institutions or tracking views against videos they don't have access to.
 *
 * GAMIFICATION (PR #99): xpHookForVideoComplete wired on first completion.
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { PREFIX, authenticate, safeJson, ok, err, getAdminClient } from "../../db.ts";
import { safeErr } from "../../lib/safe-error.ts";
import { isUuid } from "../../validate.ts";
import {
  requireInstitutionRole,
  isDenied,
  ALL_ROLES,
} from "../../auth-helpers.ts";
import { fireFirstCompletionSignal } from "./helpers.ts";
import { xpHookForVideoComplete } from "../../xp-hooks.ts";
import { resolveInstitutionViaRpc } from "../../lib/institution-resolver.ts";

export const muxTrackingRoutes = new Hono();

muxTrackingRoutes.post(`${PREFIX}/mux/track-view`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const {
    video_id,
    // W7-SEC03 FIX: institution_id removed from body destructuring
    watch_time_seconds = 0, total_watch_time_seconds = 0,
    completion_percentage = 0, completed = false, last_position_seconds = 0,
  } = body;

  if (!isUuid(video_id)) return err(c, "video_id must be a valid UUID", 400);

  // W7-SEC03 FIX: Resolve institution server-side from video→summary chain.
  // This also validates the video exists and user has access.
  const { data: videoRow, error: videoErr } = await db
    .from("videos").select("summary_id")
    .eq("id", video_id).single();

  if (videoErr || !videoRow)
    return err(c, "Video not found", 404);

  const institution_id = await resolveInstitutionViaRpc(db, "summaries", videoRow.summary_id);
  if (!institution_id) return err(c, "Cannot resolve video institution", 404);

  // Verify user has membership in this institution
  const roleCheck = await requireInstitutionRole(
    db, user.id, institution_id, ALL_ROLES,
  );
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status);

  // ── Primary: atomic DB function (N-7 FIX) ──
  // SEC-S9B: Use admin client for SECURITY DEFINER RPCs
  const { data: rpcData, error: rpcError } = await getAdminClient().rpc("upsert_video_view", {
    p_video_id: video_id, p_user_id: user.id, p_institution_id: institution_id,
    p_watch_time_seconds: watch_time_seconds,
    p_total_watch_time_seconds: total_watch_time_seconds,
    p_completion_percentage: completion_percentage,
    p_completed: completed, p_last_position_seconds: last_position_seconds,
  });

  if (!rpcError && rpcData) {
    const view = rpcData.view;
    const isFirstCompletion = rpcData.first_completion;
    if (isFirstCompletion) {
      await fireFirstCompletionSignal(db, user.id, video_id);
      // PR #99: Award video completion XP (20 XP, fire-and-forget)
      xpHookForVideoComplete(user.id, video_id, institution_id);
    }
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

  if (upsertErr) return safeErr(c, "Track view", upsertErr);
  if (isFirstCompletion) {
    await fireFirstCompletionSignal(db, user.id, video_id);
    // PR #99: Award video completion XP (20 XP, fire-and-forget)
    xpHookForVideoComplete(user.id, video_id, institution_id);
  }
  return ok(c, { ...view, first_completion: isFirstCompletion });
});

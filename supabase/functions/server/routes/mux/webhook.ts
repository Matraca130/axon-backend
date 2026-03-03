/**
 * routes/mux/webhook.ts — Mux webhook handler
 *
 * POST /webhooks/mux — Handles asset.ready / asset.errored events.
 * No auth — verified by HMAC-SHA256 signature.
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { PREFIX, ok, err, getAdminClient } from "../../db.ts";
import { verifyMuxWebhook } from "./helpers.ts";

export const muxWebhookRoutes = new Hono();

muxWebhookRoutes.post(`${PREFIX}/webhooks/mux`, async (c: Context) => {
  const rawBody  = await c.req.text();
  const signature = c.req.header("mux-signature") ?? null;

  const valid = await verifyMuxWebhook(rawBody, signature);
  if (!valid) return err(c, "Invalid Mux webhook signature", 401);

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
    const resTier    = event.data.resolution_tier ?? null;
    const thumbnail  = playbackId ? `https://image.mux.com/${playbackId}/thumbnail.jpg` : null;

    const { data: video } = await admin
      .from("videos").select("id").eq("mux_upload_id", uploadId ?? "").single();

    if (video) {
      await admin.from("videos").update({
        mux_asset_id: assetId, mux_playback_id: playbackId,
        status: "ready", is_active: true,
        url: playbackId ? `https://stream.mux.com/${playbackId}.m3u8` : "",
        duration_seconds: duration, thumbnail_url: thumbnail,
        aspect_ratio: aspectRatio, max_resolution: resTier,
        updated_at: new Date().toISOString(),
      }).eq("id", video.id);
    }
  } else if (event.type === "video.asset.errored") {
    const uploadId = event.data.upload_id;
    if (uploadId) {
      await admin.from("videos")
        .update({ status: "errored", updated_at: new Date().toISOString() })
        .eq("mux_upload_id", uploadId);
    }
  }

  return ok(c, { received: true });
});

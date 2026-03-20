-- ============================================================
-- Migration: Add Mux columns to videos table (EV-9)
-- Date: 2026-02-24
-- ============================================================
-- Adds Mux-specific columns to support direct upload workflow.
-- Existing rows default to is_mux=false (legacy URL mode).
-- ============================================================

ALTER TABLE videos
  ADD COLUMN IF NOT EXISTS mux_asset_id      text        NULL,
  ADD COLUMN IF NOT EXISTS mux_playback_id   text        NULL,
  ADD COLUMN IF NOT EXISTS mux_upload_id     text        NULL,
  ADD COLUMN IF NOT EXISTS status            text        NOT NULL DEFAULT 'pending'
                                             CHECK (status IN ('pending','uploading','processing','ready','errored')),
  ADD COLUMN IF NOT EXISTS thumbnail_url     text        NULL,
  ADD COLUMN IF NOT EXISTS aspect_ratio      text        NULL,
  ADD COLUMN IF NOT EXISTS max_resolution    text        NULL,
  ADD COLUMN IF NOT EXISTS is_mux            boolean     NOT NULL DEFAULT false;

-- Index for webhook lookups (asset.ready → find video by mux_asset_id)
CREATE INDEX IF NOT EXISTS idx_videos_mux_asset_id
  ON videos (mux_asset_id)
  WHERE mux_asset_id IS NOT NULL;

-- Index for upload status polling
CREATE INDEX IF NOT EXISTS idx_videos_mux_upload_id
  ON videos (mux_upload_id)
  WHERE mux_upload_id IS NOT NULL;

COMMENT ON COLUMN videos.mux_asset_id    IS 'Mux asset ID — set after asset.ready webhook';
COMMENT ON COLUMN videos.mux_playback_id IS 'Mux playback ID — used to build HLS/signed URLs';
COMMENT ON COLUMN videos.mux_upload_id   IS 'Mux direct upload ID — used during upload phase';
COMMENT ON COLUMN videos.status          IS 'pending|uploading|processing|ready|errored';
COMMENT ON COLUMN videos.is_mux          IS 'true=Mux managed, false=legacy URL';

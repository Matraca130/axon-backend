-- ============================================================
-- Migration: Create video_views table (EV-9)
-- Date: 2026-02-24
-- ============================================================
-- Tracks per-user video watch progress and completion.
-- UNIQUE(video_id, user_id) → UPSERT on each track-view call.
-- completion_percentage triggers BKT/FSRS signal when completed=true first time.
-- ============================================================

CREATE TABLE IF NOT EXISTS video_views (
  id                          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id                    uuid          NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id                     uuid          NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  institution_id              uuid          NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,

  -- Watch progress
  watch_time_seconds          numeric       NOT NULL DEFAULT 0 CHECK (watch_time_seconds >= 0),
  total_watch_time_seconds    numeric       NOT NULL DEFAULT 0 CHECK (total_watch_time_seconds >= 0),
  completion_percentage       numeric       NOT NULL DEFAULT 0 CHECK (completion_percentage BETWEEN 0 AND 100),
  completed                   boolean       NOT NULL DEFAULT false,
  last_position_seconds       numeric       NOT NULL DEFAULT 0 CHECK (last_position_seconds >= 0),
  view_count                  integer       NOT NULL DEFAULT 0 CHECK (view_count >= 0),

  -- Timestamps
  created_at                  timestamptz   NOT NULL DEFAULT now(),
  updated_at                  timestamptz   NOT NULL DEFAULT now(),

  -- One row per user per video
  CONSTRAINT uq_video_views_video_user UNIQUE (video_id, user_id)
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_video_views_video_id
  ON video_views (video_id);

CREATE INDEX IF NOT EXISTS idx_video_views_user_id
  ON video_views (user_id);

CREATE INDEX IF NOT EXISTS idx_video_views_institution_id
  ON video_views (institution_id);

-- Auto-update updated_at on row change
CREATE OR REPLACE FUNCTION update_video_views_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_video_views_updated_at ON video_views;
CREATE TRIGGER trg_video_views_updated_at
  BEFORE UPDATE ON video_views
  FOR EACH ROW EXECUTE FUNCTION update_video_views_updated_at();

-- RLS: users can only read/write their own rows
ALTER TABLE video_views ENABLE ROW LEVEL SECURITY;

CREATE POLICY "video_views: user can read own rows"
  ON video_views FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "video_views: user can insert own rows"
  ON video_views FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "video_views: user can update own rows"
  ON video_views FOR UPDATE
  USING (auth.uid() = user_id);

COMMENT ON TABLE video_views IS 'Per-user video watch progress. UNIQUE(video_id, user_id) — use UPSERT.';
COMMENT ON COLUMN video_views.completion_percentage IS '0-100. BKT/FSRS signal fired when completed=true first time.';

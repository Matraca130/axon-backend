-- ============================================================
-- N-7: Atomic upsert_video_view() — eliminates race condition
-- ============================================================
-- Replaces the old read+write pattern in POST /mux/track-view
-- with a single atomic INSERT ... ON CONFLICT DO UPDATE.
--
-- Key behavior:
--   1. INSERT new row with view_count=1, OR
--   2. UPDATE existing row AND increment view_count atomically
--   3. Return the row + whether this is the first completion
--
-- Requires: UNIQUE(video_id, user_id) on video_views table.
--
-- Run in: Supabase SQL Editor
-- Rollback: DROP FUNCTION IF EXISTS upsert_video_view;
-- ============================================================

CREATE OR REPLACE FUNCTION upsert_video_view(
  p_video_id UUID,
  p_user_id UUID,
  p_institution_id UUID,
  p_watch_time_seconds INTEGER DEFAULT 0,
  p_total_watch_time_seconds INTEGER DEFAULT 0,
  p_completion_percentage NUMERIC DEFAULT 0,
  p_completed BOOLEAN DEFAULT FALSE,
  p_last_position_seconds INTEGER DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_view video_views%ROWTYPE;
  v_was_completed BOOLEAN;
  v_first_completion BOOLEAN := FALSE;
BEGIN
  -- Step 1: Snapshot current completion status BEFORE the upsert.
  -- This must be a separate query because the ON CONFLICT UPDATE
  -- overwrites `completed` before we can compare old vs new.
  SELECT completed INTO v_was_completed
  FROM video_views
  WHERE video_id = p_video_id AND user_id = p_user_id;

  -- Step 2: Atomic INSERT or UPDATE with view_count increment.
  -- The ON CONFLICT clause guarantees no lost updates even under
  -- concurrent requests from the same user watching the same video.
  INSERT INTO video_views (
    video_id, user_id, institution_id,
    watch_time_seconds, total_watch_time_seconds,
    completion_percentage, completed,
    last_position_seconds, view_count,
    updated_at
  ) VALUES (
    p_video_id, p_user_id, p_institution_id,
    p_watch_time_seconds, p_total_watch_time_seconds,
    p_completion_percentage, p_completed,
    p_last_position_seconds, 1,
    NOW()
  )
  ON CONFLICT (video_id, user_id) DO UPDATE SET
    watch_time_seconds       = EXCLUDED.watch_time_seconds,
    total_watch_time_seconds = EXCLUDED.total_watch_time_seconds,
    completion_percentage    = EXCLUDED.completion_percentage,
    completed                = EXCLUDED.completed,
    last_position_seconds    = EXCLUDED.last_position_seconds,
    view_count               = video_views.view_count + 1,
    updated_at               = NOW()
  RETURNING * INTO v_view;

  -- Step 3: Determine first-completion signal.
  -- True only when: user is now marking completed=true AND
  -- they had never completed before (NULL = new row, false = existing).
  v_first_completion := p_completed
    AND (v_was_completed IS NULL OR NOT v_was_completed);

  RETURN jsonb_build_object(
    'view', to_jsonb(v_view),
    'first_completion', v_first_completion
  );
END;
$$;

-- Verification query (run after applying):
-- SELECT proname, prorettype::regtype
-- FROM pg_proc WHERE proname = 'upsert_video_view';

-- ============================================================
-- Migration: upsert_video_view DB function
-- N-7 FIX: Atomic view_count increment via ON CONFLICT.
-- Eliminates race condition where concurrent track-view calls
-- could both read count=5 and write count=6 instead of 7.
--
-- Usage:
--   SELECT * FROM upsert_video_view(
--     p_video_id := 'uuid',
--     p_user_id := 'uuid',
--     p_institution_id := 'uuid',
--     p_watch_time_seconds := 120,
--     p_total_watch_time_seconds := 300,
--     p_completion_percentage := 0.75,
--     p_completed := true,
--     p_last_position_seconds := 180
--   );
--
-- Returns: the upserted row + was_already_completed (for BKT signal)
--
-- IMPORTANT: Run this in the Supabase SQL Editor.
-- ============================================================

CREATE OR REPLACE FUNCTION upsert_video_view(
  p_video_id uuid,
  p_user_id uuid,
  p_institution_id uuid,
  p_watch_time_seconds int DEFAULT 0,
  p_total_watch_time_seconds int DEFAULT 0,
  p_completion_percentage numeric DEFAULT 0,
  p_completed boolean DEFAULT false,
  p_last_position_seconds int DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_was_completed boolean;
  v_result video_views;
BEGIN
  -- Check if already completed (for BKT/FSRS signal)
  SELECT completed INTO v_was_completed
  FROM video_views
  WHERE video_id = p_video_id AND user_id = p_user_id;

  -- Atomic upsert with view_count + 1
  INSERT INTO video_views (
    video_id, user_id, institution_id,
    watch_time_seconds, total_watch_time_seconds,
    completion_percentage, completed,
    last_position_seconds, view_count, updated_at
  ) VALUES (
    p_video_id, p_user_id, p_institution_id,
    p_watch_time_seconds, p_total_watch_time_seconds,
    p_completion_percentage, p_completed,
    p_last_position_seconds, 1, now()
  )
  ON CONFLICT (video_id, user_id) DO UPDATE SET
    institution_id = EXCLUDED.institution_id,
    watch_time_seconds = EXCLUDED.watch_time_seconds,
    total_watch_time_seconds = EXCLUDED.total_watch_time_seconds,
    completion_percentage = EXCLUDED.completion_percentage,
    completed = EXCLUDED.completed,
    last_position_seconds = EXCLUDED.last_position_seconds,
    view_count = video_views.view_count + 1,
    updated_at = now()
  RETURNING * INTO v_result;

  RETURN jsonb_build_object(
    'view', to_jsonb(v_result),
    'first_completion', (p_completed AND NOT COALESCE(v_was_completed, false))
  );
END;
$$;

GRANT EXECUTE ON FUNCTION upsert_video_view(
  uuid, uuid, uuid, int, int, numeric, boolean, int
) TO anon, authenticated;

COMMENT ON FUNCTION upsert_video_view IS
  'Atomic video view upsert with view_count + 1. Returns first_completion flag for BKT signal.';

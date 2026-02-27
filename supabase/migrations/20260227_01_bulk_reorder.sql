-- ============================================================
-- Migration: bulk_reorder DB function
-- M-3 performance fix: replaces N individual UPDATE queries
-- with a single UPDATE ... FROM jsonb_array_elements().
--
-- Usage from PostgREST / Supabase client:
--   SELECT bulk_reorder('courses', '[{"id":"...","order_index":0}, ...]'::jsonb);
--
-- IMPORTANT: Run this in the Supabase SQL Editor or via supabase db push.
-- ============================================================

CREATE OR REPLACE FUNCTION bulk_reorder(
  p_table text,
  p_items jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count int;
  v_has_updated_at bool;
BEGIN
  -- ── Allowlist (belt-and-suspenders with Hono validation) ──
  IF p_table NOT IN (
    'courses', 'semesters', 'sections', 'topics', 'summaries',
    'chunks', 'subtopics', 'videos', 'models_3d', 'model_3d_pins',
    'study_plan_tasks'
  ) THEN
    RAISE EXCEPTION 'Table "%" not allowed for reorder', p_table;
  END IF;

  -- ── Validate items array ──
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'p_items must be a non-empty JSON array';
  END IF;

  IF jsonb_array_length(p_items) > 200 THEN
    RAISE EXCEPTION 'Too many items: % (max 200)', jsonb_array_length(p_items);
  END IF;

  -- ── Determine if table has updated_at column ──
  v_has_updated_at := p_table IN (
    'courses', 'semesters', 'sections', 'topics', 'summaries',
    'videos', 'models_3d', 'model_3d_pins'
  );

  -- ── Single UPDATE with join on jsonb_array_elements ──
  IF v_has_updated_at THEN
    EXECUTE format(
      'UPDATE %I t
       SET order_index = (i->>''order_index'')::int,
           updated_at  = now()
       FROM jsonb_array_elements($1) AS i
       WHERE t.id = (i->>''id'')::uuid',
      p_table
    ) USING p_items;
  ELSE
    EXECUTE format(
      'UPDATE %I t
       SET order_index = (i->>''order_index'')::int
       FROM jsonb_array_elements($1) AS i
       WHERE t.id = (i->>''id'')::uuid',
      p_table
    ) USING p_items;
  END IF;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN jsonb_build_object('reordered', v_count);
END;
$$;

-- Grant execute to the anon and authenticated roles so PostgREST can call it
GRANT EXECUTE ON FUNCTION bulk_reorder(text, jsonb) TO anon, authenticated;

COMMENT ON FUNCTION bulk_reorder IS
  'Bulk-update order_index for any orderable table. Single query, O(1) round-trips.';

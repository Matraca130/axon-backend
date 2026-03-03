-- ============================================================
-- N-5: Content tree as a single DB function
-- ============================================================
-- Builds the nested hierarchy using jsonb_agg, filtering out
-- inactive and soft-deleted nodes at the SQL level.
-- This eliminates the bandwidth tax of fetching all nodes
-- and filtering them in JavaScript.
--
-- Usage:  SELECT get_content_tree('institution-uuid');
-- Returns: jsonb array of courses with nested semesters/sections/topics
--
-- Status: PENDING — run in Supabase SQL Editor
-- ============================================================

CREATE OR REPLACE FUNCTION get_content_tree(p_institution_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', c.id,
      'name', c.name,
      'description', c.description,
      'order_index', c.order_index,
      'is_active', c.is_active,
      'semesters', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', s.id,
            'name', s.name,
            'order_index', s.order_index,
            'is_active', s.is_active,
            'sections', COALESCE((
              SELECT jsonb_agg(
                jsonb_build_object(
                  'id', sec.id,
                  'name', sec.name,
                  'order_index', sec.order_index,
                  'is_active', sec.is_active,
                  'topics', COALESCE((
                    SELECT jsonb_agg(
                      jsonb_build_object(
                        'id', t.id,
                        'name', t.name,
                        'order_index', t.order_index,
                        'is_active', t.is_active
                      ) ORDER BY t.order_index
                    )
                    FROM topics t
                    WHERE t.section_id = sec.id
                      AND t.is_active = true
                      AND t.deleted_at IS NULL
                  ), '[]'::jsonb)
                ) ORDER BY sec.order_index
              )
              FROM sections sec
              WHERE sec.semester_id = s.id
                AND sec.is_active = true
                AND sec.deleted_at IS NULL
            ), '[]'::jsonb)
          ) ORDER BY s.order_index
        )
        FROM semesters s
        WHERE s.course_id = c.id
          AND s.is_active = true
          AND s.deleted_at IS NULL
      ), '[]'::jsonb)
    ) ORDER BY c.order_index
  ), '[]'::jsonb)
  FROM courses c
  WHERE c.institution_id = p_institution_id
    AND c.is_active = true
    AND c.deleted_at IS NULL;
$$;

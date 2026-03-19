-- ============================================================
-- Migration: resolve_student_summary_ids RPC
-- Date: 2026-03-19
-- Task: 3.5 — Replace 6-query waterfall in resolvers.ts
--
-- Given a student UUID and institution UUID, returns all
-- published summary IDs the student can access via membership.
--
-- Security: SECURITY DEFINER with restricted search_path.
-- ============================================================

CREATE OR REPLACE FUNCTION resolve_student_summary_ids(
  p_student_id      UUID,
  p_institution_id  UUID
)
RETURNS TABLE(summary_id UUID)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT s.id
  FROM summaries s
  WHERE s.institution_id = p_institution_id
    AND s.deleted_at IS NULL
    AND s.is_active = true
    AND s.status = 'published'
    AND EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.user_id = p_student_id
        AND m.institution_id = p_institution_id
        AND m.is_active = true
    );
$$;

GRANT EXECUTE ON FUNCTION resolve_student_summary_ids(UUID, UUID) TO authenticated;

COMMENT ON FUNCTION resolve_student_summary_ids IS
  'Task 3.5: Returns published summary IDs accessible to a student within an institution. Replaces 6-query waterfall in resolvers.ts.';

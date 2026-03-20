-- ============================================================
-- Migration: Scoped Search, Trash & Institution Resolution
-- Date: 2026-03-04
-- Issue: H-4 (search/trash without institution scoping)
--
-- Creates 3 functions:
--   1. search_scoped()              — institution-scoped content search
--   2. trash_scoped()               — institution-scoped deleted items
--   3. resolve_summary_institution() — summary → institution_id helper
--
-- Security model:
--   All functions use auth.uid() to identify the caller.
--   SECURITY DEFINER bypasses RLS; scoping is enforced by the
--   user_institutions CTE which queries memberships.
--   A NULL auth.uid() (unauthenticated) returns zero rows.
--
-- Performance notes:
--   - search_scoped uses existing trigram indexes (O-4 migration)
--   - allowed_summaries CTE uses the same JOIN chain as
--     get_course_summary_ids (M-1) and get_study_queue (C-2)
--   - Path resolution is done in SQL to avoid extra round trips
-- ============================================================


-- ============================================================
-- 1. search_scoped: Institution-scoped content search
-- ============================================================
-- Replaces the 3 parallel PostgREST queries + batchResolvePaths
-- with a single SQL call that:
--   a) Scopes to caller's institutions via memberships
--   b) Searches summaries, keywords, videos with ILIKE
--   c) Resolves parent paths in SQL
--   d) Returns unified, scored results
--
-- Usage from TypeScript:
--   const { data } = await db.rpc('search_scoped', {
--     p_query: 'mitosis',
--     p_type: 'all',
--     p_limit: 20
--   });
-- ============================================================

CREATE OR REPLACE FUNCTION search_scoped(
  p_query   TEXT,
  p_type    TEXT    DEFAULT 'all',
  p_limit   INTEGER DEFAULT 20
)
RETURNS TABLE (
  result_type  TEXT,
  result_id    UUID,
  title        TEXT,
  snippet      TEXT,
  parent_path  TEXT,
  relevance    INTEGER
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_escaped TEXT;
  v_pattern TEXT;
  v_sub_limit INTEGER;
BEGIN
  -- Unauthenticated: return nothing
  IF v_uid IS NULL THEN
    RETURN;
  END IF;

  -- Validate and clamp limit
  IF p_limit IS NULL OR p_limit < 1 THEN
    p_limit := 20;
  ELSIF p_limit > 100 THEN
    p_limit := 100;
  END IF;

  -- Escape ILIKE wildcards to prevent wildcard injection
  -- Order matters: escape backslash first, then % and _
  v_escaped := replace(replace(replace(p_query, '\', '\\'), '%', '\%'), '_', '\_');
  v_pattern := '%' || v_escaped || '%';

  -- Per-type sub-limits: distribute results evenly for 'all' mode
  IF p_type = 'all' THEN
    v_sub_limit := GREATEST(1, p_limit / 3 + 1);
  ELSE
    v_sub_limit := p_limit;
  END IF;

  RETURN QUERY
  WITH
  -- Step 1: Resolve caller's accessible institutions
  user_institutions AS (
    SELECT m.institution_id
    FROM memberships m
    WHERE m.user_id = v_uid
      AND m.is_active = true
  ),

  -- Step 2: Resolve accessible summary IDs via hierarchy
  -- Uses the standard chain: courses → semesters → sections → topics → summaries
  allowed_summaries AS (
    SELECT s.id, s.title AS s_title, s.content_markdown, s.topic_id
    FROM summaries s
    JOIN topics t    ON t.id   = s.topic_id    AND t.deleted_at   IS NULL
    JOIN sections sec ON sec.id = t.section_id  AND sec.deleted_at IS NULL
    JOIN semesters sem ON sem.id = sec.semester_id AND sem.deleted_at IS NULL
    JOIN courses c   ON c.id   = sem.course_id AND c.is_active = true
    WHERE c.institution_id IN (SELECT institution_id FROM user_institutions)
      AND s.deleted_at IS NULL
  ),

  -- Step 3a: Search summaries
  matched_summaries AS (
    SELECT
      'summary'::TEXT AS rt,
      a.id            AS rid,
      a.s_title       AS t,
      CASE
        WHEN a.s_title ILIKE v_pattern THEN a.s_title
        ELSE LEFT(COALESCE(a.content_markdown, ''), 120) || '...'
      END AS snip,
      -- Path: course > semester > topic
      COALESCE(
        (
          SELECT c.name || ' > ' || sem.name || ' > ' || t.name
          FROM topics t
          JOIN sections sec ON sec.id = t.section_id
          JOIN semesters sem ON sem.id = sec.semester_id
          JOIN courses c ON c.id = sem.course_id
          WHERE t.id = a.topic_id
          LIMIT 1
        ), ''
      ) AS pp,
      CASE WHEN a.s_title ILIKE v_pattern THEN 2 ELSE 1 END AS rel
    FROM allowed_summaries a
    WHERE (a.s_title ILIKE v_pattern OR a.content_markdown ILIKE v_pattern)
    ORDER BY (CASE WHEN a.s_title ILIKE v_pattern THEN 0 ELSE 1 END), a.s_title
    LIMIT v_sub_limit
  ),

  -- Step 3b: Search keywords (within allowed summaries)
  matched_keywords AS (
    SELECT
      'keyword'::TEXT AS rt,
      k.id            AS rid,
      k.name          AS t,
      CASE
        WHEN k.name ILIKE v_pattern THEN COALESCE(LEFT(k.definition, 120), k.name)
        ELSE COALESCE(LEFT(k.definition, 120), '') || '...'
      END AS snip,
      -- Path: course > semester > topic > summary
      COALESCE(
        (
          SELECT c.name || ' > ' || sem.name || ' > ' || t.name || ' > ' || a.s_title
          FROM allowed_summaries a
          JOIN topics t ON t.id = a.topic_id
          JOIN sections sec ON sec.id = t.section_id
          JOIN semesters sem ON sem.id = sec.semester_id
          JOIN courses c ON c.id = sem.course_id
          WHERE a.id = k.summary_id
          LIMIT 1
        ), ''
      ) AS pp,
      CASE WHEN k.name ILIKE v_pattern THEN 2 ELSE 1 END AS rel
    FROM keywords k
    WHERE k.summary_id IN (SELECT id FROM allowed_summaries)
      AND k.deleted_at IS NULL
      AND (k.name ILIKE v_pattern OR k.definition ILIKE v_pattern)
    ORDER BY (CASE WHEN k.name ILIKE v_pattern THEN 0 ELSE 1 END), k.name
    LIMIT v_sub_limit
  ),

  -- Step 3c: Search videos (within allowed summaries)
  matched_videos AS (
    SELECT
      'video'::TEXT AS rt,
      v.id          AS rid,
      v.title       AS t,
      v.title       AS snip,
      COALESCE(
        (
          SELECT c.name || ' > ' || sem.name || ' > ' || t.name || ' > ' || a.s_title
          FROM allowed_summaries a
          JOIN topics t ON t.id = a.topic_id
          JOIN sections sec ON sec.id = t.section_id
          JOIN semesters sem ON sem.id = sec.semester_id
          JOIN courses c ON c.id = sem.course_id
          WHERE a.id = v.summary_id
          LIMIT 1
        ), ''
      ) AS pp,
      2 AS rel
    FROM videos v
    WHERE v.summary_id IN (SELECT id FROM allowed_summaries)
      AND v.deleted_at IS NULL
      AND v.title ILIKE v_pattern
    ORDER BY v.title
    LIMIT v_sub_limit
  )

  -- Combine, re-sort, and apply final limit
  SELECT rt, rid, t, snip, pp, rel
  FROM (
    SELECT * FROM matched_summaries WHERE p_type IN ('all', 'summaries')
    UNION ALL
    SELECT * FROM matched_keywords  WHERE p_type IN ('all', 'keywords')
    UNION ALL
    SELECT * FROM matched_videos    WHERE p_type IN ('all', 'videos')
  ) combined
  ORDER BY rel DESC, rt, t
  LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION search_scoped(TEXT, TEXT, INTEGER) TO authenticated;

COMMENT ON FUNCTION search_scoped IS
  'H-4 fix: Institution-scoped search using auth.uid(). Replaces unscoped PostgREST queries.';


-- ============================================================
-- 2. trash_scoped: Institution-scoped deleted items
-- ============================================================
-- Lists soft-deleted items from tables the caller has access to.
-- Hierarchy filters are relaxed (no deleted_at on parents) so that
-- items whose parent was also deleted still appear in trash.
--
-- Usage from TypeScript:
--   const { data } = await db.rpc('trash_scoped', {
--     p_type: 'all',
--     p_limit: 50
--   });
-- ============================================================

CREATE OR REPLACE FUNCTION trash_scoped(
  p_type  TEXT    DEFAULT 'all',
  p_limit INTEGER DEFAULT 50
)
RETURNS TABLE (
  result_type TEXT,
  result_id   UUID,
  title       TEXT,
  deleted_at  TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RETURN;
  END IF;

  IF p_limit IS NULL OR p_limit < 1 THEN
    p_limit := 50;
  ELSIF p_limit > 200 THEN
    p_limit := 200;
  END IF;

  RETURN QUERY
  WITH
  -- Caller's institutions
  user_institutions AS (
    SELECT m.institution_id
    FROM memberships m
    WHERE m.user_id = v_uid AND m.is_active = true
  ),

  -- ALL summary IDs in caller's institutions (including deleted summaries)
  -- No deleted_at filters on hierarchy: deleted parents should still
  -- allow their children to appear in trash.
  institution_summaries AS (
    SELECT s.id
    FROM summaries s
    JOIN topics t     ON t.id   = s.topic_id
    JOIN sections sec ON sec.id = t.section_id
    JOIN semesters sem ON sem.id = sec.semester_id
    JOIN courses c    ON c.id   = sem.course_id
    WHERE c.institution_id IN (SELECT institution_id FROM user_institutions)
  ),

  -- Deleted summaries
  deleted_summaries AS (
    SELECT 'summaries'::TEXT AS rt, s.id, s.title, s.deleted_at
    FROM summaries s
    WHERE s.id IN (SELECT id FROM institution_summaries)
      AND s.deleted_at IS NOT NULL
  ),

  -- Deleted keywords
  deleted_keywords AS (
    SELECT 'keywords'::TEXT AS rt, k.id, k.name AS title, k.deleted_at
    FROM keywords k
    WHERE k.summary_id IN (SELECT id FROM institution_summaries)
      AND k.deleted_at IS NOT NULL
  ),

  -- Deleted flashcards
  deleted_flashcards AS (
    SELECT 'flashcards'::TEXT AS rt, f.id, f.front AS title, f.deleted_at
    FROM flashcards f
    WHERE f.summary_id IN (SELECT id FROM institution_summaries)
      AND f.deleted_at IS NOT NULL
  ),

  -- Deleted quiz questions
  deleted_quiz AS (
    SELECT 'quiz-questions'::TEXT AS rt, q.id, q.question_text AS title, q.deleted_at
    FROM quiz_questions q
    WHERE q.summary_id IN (SELECT id FROM institution_summaries)
      AND q.deleted_at IS NOT NULL
  ),

  -- Deleted videos
  deleted_videos AS (
    SELECT 'videos'::TEXT AS rt, v.id, v.title, v.deleted_at
    FROM videos v
    WHERE v.summary_id IN (SELECT id FROM institution_summaries)
      AND v.deleted_at IS NOT NULL
  )

  SELECT rt, id, title, x.deleted_at
  FROM (
    SELECT * FROM deleted_summaries  WHERE p_type IN ('all', 'summaries')
    UNION ALL
    SELECT * FROM deleted_keywords   WHERE p_type IN ('all', 'keywords')
    UNION ALL
    SELECT * FROM deleted_flashcards WHERE p_type IN ('all', 'flashcards')
    UNION ALL
    SELECT * FROM deleted_quiz       WHERE p_type IN ('all', 'quiz-questions')
    UNION ALL
    SELECT * FROM deleted_videos     WHERE p_type IN ('all', 'videos')
  ) x
  ORDER BY x.deleted_at DESC
  LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION trash_scoped(TEXT, INTEGER) TO authenticated;

COMMENT ON FUNCTION trash_scoped IS
  'H-4 fix: Institution-scoped trash listing using auth.uid(). Replaces unscoped global queries.';


-- ============================================================
-- 3. resolve_summary_institution: Summary → Institution ID
-- ============================================================
-- Given a summary UUID, walks the hierarchy to find its institution.
-- Works even for deleted items (no deleted_at filters on hierarchy).
-- Reusable by Phase 4 (content CRUD scoping).
--
-- Returns NULL if:
--   - summary doesn't exist
--   - hierarchy is broken (missing FK)
--   - p_summary_id is NULL
--
-- Usage from TypeScript:
--   const { data } = await db.rpc('resolve_summary_institution', {
--     p_summary_id: 'abc-123'
--   });
--   // data = 'institution-uuid' or null
-- ============================================================

CREATE OR REPLACE FUNCTION resolve_summary_institution(p_summary_id UUID)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT c.institution_id
  FROM summaries s
  JOIN topics t     ON t.id   = s.topic_id
  JOIN sections sec ON sec.id = t.section_id
  JOIN semesters sem ON sem.id = sec.semester_id
  JOIN courses c    ON c.id   = sem.course_id
  WHERE s.id = p_summary_id
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION resolve_summary_institution(UUID) TO authenticated;

COMMENT ON FUNCTION resolve_summary_institution IS
  'Resolves summary_id → institution_id via topic → section → semester → course chain. Phase 4 reusable.';

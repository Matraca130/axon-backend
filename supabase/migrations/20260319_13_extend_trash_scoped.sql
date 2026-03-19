-- ============================================================
-- Migration: Extend trash_scoped to include hierarchy tables
-- Date: 2026-03-19
-- Task: 9.2 — Add courses, semesters, sections, topics to trash
--
-- Replaces the existing trash_scoped function to also search
-- courses, semesters, sections, and topics (in addition to
-- existing summaries, keywords, flashcards, quiz_questions, videos).
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
SET search_path = public, pg_temp
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

  -- Deleted courses
  deleted_courses AS (
    SELECT 'courses'::TEXT AS rt, c.id, c.name AS title, c.deleted_at
    FROM courses c
    WHERE c.institution_id IN (SELECT institution_id FROM user_institutions)
      AND c.deleted_at IS NOT NULL
  ),

  -- Deleted semesters
  deleted_semesters AS (
    SELECT 'semesters'::TEXT AS rt, sem.id, sem.name AS title, sem.deleted_at
    FROM semesters sem
    JOIN courses c ON c.id = sem.course_id
    WHERE c.institution_id IN (SELECT institution_id FROM user_institutions)
      AND sem.deleted_at IS NOT NULL
  ),

  -- Deleted sections
  deleted_sections AS (
    SELECT 'sections'::TEXT AS rt, sec.id, sec.name AS title, sec.deleted_at
    FROM sections sec
    JOIN semesters sem ON sem.id = sec.semester_id
    JOIN courses c ON c.id = sem.course_id
    WHERE c.institution_id IN (SELECT institution_id FROM user_institutions)
      AND sec.deleted_at IS NOT NULL
  ),

  -- Deleted topics
  deleted_topics AS (
    SELECT 'topics'::TEXT AS rt, t.id, t.name AS title, t.deleted_at
    FROM topics t
    JOIN sections sec ON sec.id = t.section_id
    JOIN semesters sem ON sem.id = sec.semester_id
    JOIN courses c ON c.id = sem.course_id
    WHERE c.institution_id IN (SELECT institution_id FROM user_institutions)
      AND t.deleted_at IS NOT NULL
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
    SELECT * FROM deleted_courses    WHERE p_type IN ('all', 'courses')
    UNION ALL
    SELECT * FROM deleted_semesters  WHERE p_type IN ('all', 'semesters')
    UNION ALL
    SELECT * FROM deleted_sections   WHERE p_type IN ('all', 'sections')
    UNION ALL
    SELECT * FROM deleted_topics     WHERE p_type IN ('all', 'topics')
    UNION ALL
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

COMMENT ON FUNCTION trash_scoped IS
  'Task 9.2: Extended trash_scoped — now includes courses, semesters, sections, topics in addition to summaries, keywords, flashcards, quiz_questions, videos.';

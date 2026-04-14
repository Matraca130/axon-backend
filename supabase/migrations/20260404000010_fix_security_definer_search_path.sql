-- ============================================================================
-- Migration: Fix SECURITY DEFINER functions missing SET search_path
-- Date: 2026-04-04
-- Issue: BH-ERR-015
--
-- Problem:
--   9 SECURITY DEFINER functions are missing `SET search_path = public, pg_temp`.
--   Without this, a malicious user could create a schema with poisoned functions
--   that shadow public functions, and the SECURITY DEFINER context would execute
--   them with elevated privileges (search_path hijack).
--
-- Fix:
--   Re-define each function with `SET search_path = public, pg_temp` added.
--   Function logic is UNCHANGED — only the search_path setting is added.
--
-- Functions fixed (9):
--   1. get_course_summary_ids        (from 20260227000002)
--   2. upsert_video_view             (from 20260227000003)
--   3. search_scoped                 (from 20260304000003)
--   4. resolve_summary_institution   (from 20260304000003)
--   5. get_student_knowledge_context (from 20260305000002)
--   6. rag_analytics_summary         (from 20260305000005)
--   7. rag_embedding_coverage        (from 20260305000005)
--   8. search_keywords_by_institution(from 20260306000004)
--   9. get_ai_report_stats           (from 20260308000003)
--
-- Idempotent: CREATE OR REPLACE — safe to re-run.
-- ============================================================================


-- ─── 1. get_course_summary_ids ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION get_course_summary_ids(
  p_course_id uuid
)
RETURNS TABLE(id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT s.id
  FROM summaries s
  JOIN topics t   ON s.topic_id    = t.id  AND t.deleted_at  IS NULL
  JOIN sections sec ON t.section_id  = sec.id AND sec.deleted_at IS NULL
  JOIN semesters sem ON sec.semester_id = sem.id AND sem.deleted_at IS NULL
  WHERE sem.course_id = p_course_id
    AND s.deleted_at IS NULL;
$$;


-- ─── 2. upsert_video_view ──────────────────────────────────────────────────

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
SET search_path = public, pg_temp
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


-- ─── 3. search_scoped ──────────────────────────────────────────────────────

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
SET search_path = public, pg_temp
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
  user_institutions AS (
    SELECT m.institution_id
    FROM memberships m
    WHERE m.user_id = v_uid
      AND m.is_active = true
  ),
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
  matched_summaries AS (
    SELECT
      'summary'::TEXT AS rt,
      a.id            AS rid,
      a.s_title       AS t,
      CASE
        WHEN a.s_title ILIKE v_pattern THEN a.s_title
        ELSE LEFT(COALESCE(a.content_markdown, ''), 120) || '...'
      END AS snip,
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
  matched_keywords AS (
    SELECT
      'keyword'::TEXT AS rt,
      k.id            AS rid,
      k.name          AS t,
      CASE
        WHEN k.name ILIKE v_pattern THEN COALESCE(LEFT(k.definition, 120), k.name)
        ELSE COALESCE(LEFT(k.definition, 120), '') || '...'
      END AS snip,
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


-- ─── 4. resolve_summary_institution ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION resolve_summary_institution(p_summary_id UUID)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
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


-- ─── 5. get_student_knowledge_context ───────────────────────────────────────

CREATE OR REPLACE FUNCTION get_student_knowledge_context(
  p_student_id UUID,
  p_institution_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  result JSONB;
BEGIN
  SELECT jsonb_build_object(
    'weak', (
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
          'sub', sub.item_name,
          'kw', sub.keyword_name,
          'p', ROUND(sub.mastery_score::NUMERIC, 2),
          'att', sub.total_attempts
        ) ORDER BY sub.mastery_score ASC
      ), '[]'::JSONB)
      FROM (
        SELECT item_name, keyword_name, mastery_score, total_attempts
        FROM mv_student_knowledge_profile
        WHERE student_id = p_student_id
          AND institution_id = p_institution_id
          AND signal_type = 'subtopic_mastery'
          AND mastery_score < 0.6
        ORDER BY mastery_score ASC
        LIMIT 10
      ) sub
    ),
    'lapsing', (
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
          'card', LEFT(laps.item_name, 40),
          'kw', laps.keyword_name,
          'lapses', laps.lapses,
          'state', laps.fsrs_state
        ) ORDER BY laps.lapses DESC NULLS LAST
      ), '[]'::JSONB)
      FROM (
        SELECT item_name, keyword_name, lapses, fsrs_state
        FROM mv_student_knowledge_profile
        WHERE student_id = p_student_id
          AND institution_id = p_institution_id
          AND signal_type = 'flashcard_difficulty'
        ORDER BY lapses DESC NULLS LAST
        LIMIT 5
      ) laps
    ),
    'quiz_fail', (
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
          'q', LEFT(qf.question, 60),
          'wrong', LEFT(qf.answer, 40),
          'kw', qf.kw_name
        ) ORDER BY qf.created_at DESC
      ), '[]'::JSONB)
      FROM (
        SELECT qq.question, qa.answer, kw.name AS kw_name, qa.created_at
        FROM quiz_attempts qa
        JOIN quiz_questions qq ON qq.id = qa.quiz_question_id
        JOIN keywords kw ON kw.id = qq.keyword_id
        JOIN summaries s ON s.id = qq.summary_id
        JOIN topics t ON t.id = s.topic_id
        JOIN sections sec ON sec.id = t.section_id
        JOIN semesters sem ON sem.id = sec.semester_id
        JOIN courses c ON c.id = sem.course_id
        WHERE qa.student_id = p_student_id
          AND c.institution_id = p_institution_id
          AND qa.is_correct = FALSE
          AND qa.created_at > NOW() - INTERVAL '24 hours'
          AND qq.deleted_at IS NULL AND qq.is_active = TRUE
          AND kw.deleted_at IS NULL AND kw.is_active = TRUE
          AND s.deleted_at IS NULL AND s.is_active = TRUE
          AND t.deleted_at IS NULL AND t.is_active = TRUE
          AND sec.deleted_at IS NULL AND sec.is_active = TRUE
          AND sem.deleted_at IS NULL AND sem.is_active = TRUE
          AND c.deleted_at IS NULL AND c.is_active = TRUE
        ORDER BY qa.created_at DESC
        LIMIT 5
      ) qf
    ),
    'strong', (
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
          'sub', str.item_name,
          'kw', str.keyword_name,
          'p', ROUND(str.mastery_score::NUMERIC, 2)
        ) ORDER BY str.mastery_score DESC
      ), '[]'::JSONB)
      FROM (
        SELECT item_name, keyword_name, mastery_score
        FROM mv_student_knowledge_profile
        WHERE student_id = p_student_id
          AND institution_id = p_institution_id
          AND signal_type = 'subtopic_mastery'
          AND mastery_score > 0.85
        ORDER BY mastery_score DESC
        LIMIT 5
      ) str
    )
  ) INTO result;

  RETURN result;
END;
$$;


-- ─── 6. rag_analytics_summary ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION rag_analytics_summary(
  p_institution_id UUID,
  p_from TIMESTAMPTZ DEFAULT now() - INTERVAL '7 days',
  p_to   TIMESTAMPTZ DEFAULT now()
)
RETURNS TABLE (
  total_queries       INT,
  avg_similarity      FLOAT,
  avg_latency_ms      INT,
  positive_feedback   INT,
  negative_feedback   INT,
  zero_result_queries INT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    count(*)::INT                                          AS total_queries,
    round(avg(top_similarity)::NUMERIC, 3)::FLOAT          AS avg_similarity,
    round(avg(latency_ms)::NUMERIC, 0)::INT                AS avg_latency_ms,
    count(*) FILTER (WHERE feedback = 1)::INT               AS positive_feedback,
    count(*) FILTER (WHERE feedback = -1)::INT              AS negative_feedback,
    count(*) FILTER (WHERE results_count = 0)::INT          AS zero_result_queries
  FROM rag_query_log
  WHERE institution_id = p_institution_id
    AND created_at >= p_from
    AND created_at <= p_to;
$$;


-- ─── 7. rag_embedding_coverage ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION rag_embedding_coverage(
  p_institution_id UUID
)
RETURNS TABLE (
  total_chunks          INT,
  chunks_with_embedding INT,
  coverage_pct          FLOAT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    count(*)::INT                                             AS total_chunks,
    count(*) FILTER (WHERE ch.embedding IS NOT NULL)::INT     AS chunks_with_embedding,
    CASE
      WHEN count(*) = 0 THEN 0.0
      ELSE round(
        (count(*) FILTER (WHERE ch.embedding IS NOT NULL)::NUMERIC
         / count(*)::NUMERIC) * 100, 1
      )::FLOAT
    END                                                       AS coverage_pct
  FROM chunks ch
  JOIN summaries s ON s.id = ch.summary_id
  WHERE s.institution_id = p_institution_id
    AND s.deleted_at IS NULL
    AND s.is_active = TRUE;
$$;


-- ─── 8. search_keywords_by_institution ──────────────────────────────────────

CREATE OR REPLACE FUNCTION search_keywords_by_institution(
  p_institution_id UUID,
  p_query TEXT,
  p_exclude_summary_id UUID DEFAULT NULL,
  p_course_id UUID DEFAULT NULL,
  p_limit INT DEFAULT 15
)
RETURNS TABLE (
  id UUID,
  name TEXT,
  summary_id UUID,
  definition TEXT,
  summary_title TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    k.id,
    k.name,
    k.summary_id,
    k.definition,
    s.title AS summary_title
  FROM keywords k
  JOIN summaries s ON s.id = k.summary_id
  WHERE s.institution_id = p_institution_id
    AND s.deleted_at IS NULL
    AND s.is_active = TRUE
    AND s.status = 'published'
    AND k.deleted_at IS NULL
    AND k.name ILIKE '%' || p_query || '%'
    AND (p_exclude_summary_id IS NULL OR k.summary_id != p_exclude_summary_id)
    AND (
      p_course_id IS NULL
      OR s.id IN (
        SELECT sub_s.id
        FROM summaries sub_s
        JOIN topics t    ON sub_s.topic_id   = t.id
        JOIN sections sec ON t.section_id    = sec.id
        JOIN semesters sem ON sec.semester_id = sem.id
        WHERE sem.course_id = p_course_id
          AND sub_s.deleted_at IS NULL
      )
    )
  ORDER BY
    CASE WHEN k.name ILIKE p_query || '%' THEN 0 ELSE 1 END,
    k.name
  LIMIT LEAST(p_limit, 30);
$$;


-- ─── 9. get_ai_report_stats ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION get_ai_report_stats(
  p_institution_id UUID,
  p_from           TIMESTAMPTZ DEFAULT now() - interval '30 days',
  p_to             TIMESTAMPTZ DEFAULT now()
)
RETURNS TABLE (
  total_reports          BIGINT,
  pending_count          BIGINT,
  reviewed_count         BIGINT,
  resolved_count         BIGINT,
  dismissed_count        BIGINT,
  reason_incorrect       BIGINT,
  reason_inappropriate   BIGINT,
  reason_low_quality     BIGINT,
  reason_irrelevant      BIGINT,
  reason_other           BIGINT,
  type_quiz_question     BIGINT,
  type_flashcard         BIGINT,
  avg_resolution_hours   FLOAT,
  resolution_rate        FLOAT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    count(*)::BIGINT AS total_reports,
    count(*) FILTER (WHERE status = 'pending')::BIGINT    AS pending_count,
    count(*) FILTER (WHERE status = 'reviewed')::BIGINT   AS reviewed_count,
    count(*) FILTER (WHERE status = 'resolved')::BIGINT   AS resolved_count,
    count(*) FILTER (WHERE status = 'dismissed')::BIGINT  AS dismissed_count,
    count(*) FILTER (WHERE reason = 'incorrect')::BIGINT      AS reason_incorrect,
    count(*) FILTER (WHERE reason = 'inappropriate')::BIGINT  AS reason_inappropriate,
    count(*) FILTER (WHERE reason = 'low_quality')::BIGINT    AS reason_low_quality,
    count(*) FILTER (WHERE reason = 'irrelevant')::BIGINT     AS reason_irrelevant,
    count(*) FILTER (WHERE reason = 'other')::BIGINT          AS reason_other,
    count(*) FILTER (WHERE content_type = 'quiz_question')::BIGINT AS type_quiz_question,
    count(*) FILTER (WHERE content_type = 'flashcard')::BIGINT     AS type_flashcard,
    COALESCE(
      EXTRACT(EPOCH FROM
        avg(resolved_at - created_at) FILTER (WHERE resolved_at IS NOT NULL)
      ) / 3600.0,
      0
    )::FLOAT AS avg_resolution_hours,
    CASE
      WHEN count(*) > 0
      THEN (
        count(*) FILTER (WHERE status IN ('resolved', 'dismissed'))
      )::FLOAT / count(*)::FLOAT
      ELSE 0
    END AS resolution_rate
  FROM ai_content_reports
  WHERE institution_id = p_institution_id
    AND created_at >= p_from
    AND created_at <= p_to;
$$;

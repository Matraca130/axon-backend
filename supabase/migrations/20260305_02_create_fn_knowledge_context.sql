-- ============================================================================
-- Migration: Create get_student_knowledge_context() function
-- Date: 2026-03-05
-- Purpose: Serializes student weaknesses, lapses, quiz failures into ~50 tokens
--          for injection into Gemini prompts
--
-- PF-07 FIX: ORDER BY moved inside jsonb_agg() and subqueries to guarantee
-- deterministic ordering within the JSON arrays.
--
-- AUDIT FIX: Added kw.is_active = TRUE filter in quiz_fail subquery.
--
-- Reads from: mv_student_knowledge_profile (matview), quiz_attempts, quiz_questions
-- Returns: JSONB with keys: weak, lapsing, quiz_fail, strong
-- ============================================================================

CREATE OR REPLACE FUNCTION get_student_knowledge_context(
  p_student_id UUID,
  p_institution_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  result JSONB;
BEGIN
  SELECT jsonb_build_object(
    -- Weaknesses: subtopics with p_know < 0.6
    'weak', (
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
          'sub', sub.item_name,
          'kw', sub.keyword_name,
          'p', ROUND(sub.mastery_score::NUMERIC, 2),
          'att', sub.total_attempts
        ) ORDER BY sub.mastery_score ASC  -- PF-07 FIX: ORDER inside aggregate
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
    -- Lapsing flashcards
    'lapsing', (
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
          'card', LEFT(laps.item_name, 40),
          'kw', laps.keyword_name,
          'lapses', laps.lapses,
          'state', laps.fsrs_state
        ) ORDER BY laps.lapses DESC NULLS LAST  -- PF-07 FIX
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
    -- Recent quiz failures (last 24h)
    'quiz_fail', (
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
          'q', LEFT(qf.question, 60),
          'wrong', LEFT(qf.answer, 40),
          'kw', qf.kw_name
        ) ORDER BY qf.created_at DESC  -- PF-07 FIX
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
    -- Strengths: top subtopics with p_know > 0.85
    'strong', (
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
          'sub', str.item_name,
          'kw', str.keyword_name,
          'p', ROUND(str.mastery_score::NUMERIC, 2)
        ) ORDER BY str.mastery_score DESC  -- PF-07 FIX
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

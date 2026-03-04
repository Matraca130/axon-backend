-- ============================================================================
-- Migration: Create mv_student_knowledge_profile (Materialized View)
-- Date: 2026-03-05
-- Purpose: Aggregates BKT mastery + FSRS difficulty signals for adaptive AI
--
-- JOINs verified against:
--   - crud-factory.ts (parentKey mappings)
--   - routes-student.tsx (flashcards, quiz_questions configs)
--   - Actual FK chain: subtopics.keyword_id → keywords.summary_id →
--     summaries.topic_id → topics.section_id → sections.semester_id →
--     semesters.course_id → courses.institution_id
--
-- BUG-2 FIX: All content tables filtered by deleted_at IS NULL + is_active.
-- Note: subtopics only have deleted_at (no is_active column) — confirmed
-- from routes-student.tsx where subtopics are used as optional filters
-- but not registered as CRUD with hasIsActive.
--
-- Created WITH NO DATA — run REFRESH after creation.
-- ============================================================================

CREATE MATERIALIZED VIEW mv_student_knowledge_profile AS

-- 1. BKT: mastery per subtopic
SELECT
  bkt.student_id,
  'subtopic_mastery'::TEXT AS signal_type,
  sub.id AS item_id,
  sub.name AS item_name,
  kw.name AS keyword_name,
  kw.id AS keyword_id,
  t.name AS topic_name,
  t.id AS topic_id,
  s.id AS summary_id,
  c.institution_id,
  bkt.p_know AS mastery_score,
  bkt.total_attempts,
  bkt.correct_attempts,
  bkt.last_attempt_at,
  NULL::INTEGER AS lapses,
  NULL::TEXT AS fsrs_state
FROM bkt_states bkt
JOIN subtopics sub ON sub.id = bkt.subtopic_id
JOIN keywords kw ON kw.id = sub.keyword_id
JOIN summaries s ON s.id = kw.summary_id
JOIN topics t ON t.id = s.topic_id
JOIN sections sec ON sec.id = t.section_id
JOIN semesters sem ON sem.id = sec.semester_id
JOIN courses c ON c.id = sem.course_id
WHERE sub.deleted_at IS NULL
  AND kw.deleted_at IS NULL
  AND s.deleted_at IS NULL AND s.is_active = TRUE
  AND t.deleted_at IS NULL AND t.is_active = TRUE
  AND sec.deleted_at IS NULL AND sec.is_active = TRUE
  AND sem.deleted_at IS NULL AND sem.is_active = TRUE
  AND c.deleted_at IS NULL AND c.is_active = TRUE

UNION ALL

-- 2. FSRS: problematic flashcards (lapses > 2 or relearning)
SELECT
  fsrs.student_id,
  'flashcard_difficulty'::TEXT AS signal_type,
  fc.id AS item_id,
  fc.front AS item_name,
  kw.name AS keyword_name,
  kw.id AS keyword_id,
  t.name AS topic_name,
  t.id AS topic_id,
  s.id AS summary_id,
  c.institution_id,
  (1.0 - fsrs.difficulty / 10.0) AS mastery_score,
  fsrs.reps AS total_attempts,
  NULL::INTEGER AS correct_attempts,
  fsrs.last_review_at AS last_attempt_at,
  fsrs.lapses,
  fsrs.state AS fsrs_state
FROM fsrs_states fsrs
JOIN flashcards fc ON fc.id = fsrs.flashcard_id
JOIN keywords kw ON kw.id = fc.keyword_id
JOIN summaries s ON s.id = fc.summary_id
JOIN topics t ON t.id = s.topic_id
JOIN sections sec ON sec.id = t.section_id
JOIN semesters sem ON sem.id = sec.semester_id
JOIN courses c ON c.id = sem.course_id
WHERE fc.deleted_at IS NULL AND fc.is_active = TRUE
  AND kw.deleted_at IS NULL
  AND s.deleted_at IS NULL AND s.is_active = TRUE
  AND t.deleted_at IS NULL AND t.is_active = TRUE
  AND sec.deleted_at IS NULL AND sec.is_active = TRUE
  AND sem.deleted_at IS NULL AND sem.is_active = TRUE
  AND c.deleted_at IS NULL AND c.is_active = TRUE
  AND (fsrs.lapses > 2 OR fsrs.state = 'relearning')

WITH NO DATA;

-- Unique index required for CONCURRENTLY refresh
CREATE UNIQUE INDEX idx_mv_skp_pk
  ON mv_student_knowledge_profile (student_id, signal_type, item_id);
CREATE INDEX idx_mv_skp_student_inst
  ON mv_student_knowledge_profile (student_id, institution_id);
CREATE INDEX idx_mv_skp_mastery
  ON mv_student_knowledge_profile (student_id, signal_type, mastery_score);
CREATE INDEX idx_mv_skp_keyword
  ON mv_student_knowledge_profile (student_id, keyword_id);

-- Initial population (run manually after migration):
-- REFRESH MATERIALIZED VIEW mv_student_knowledge_profile;

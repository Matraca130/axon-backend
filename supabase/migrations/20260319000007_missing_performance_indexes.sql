-- ============================================================
-- Migration: 12 Missing Performance Indexes
-- Date: 2026-03-19
-- Purpose: Add indexes identified by query plan analysis as missing.
--          All use IF NOT EXISTS for idempotency.
--
-- Most critical: memberships(user_id, institution_id) WHERE is_active
-- This is the hottest query in the system (every authenticated request).
-- ============================================================

-- 1. memberships: user lookup with active filter (used by every auth check)
CREATE INDEX IF NOT EXISTS idx_memberships_user_institution_active
  ON memberships (user_id, institution_id)
  WHERE is_active = true;

-- 2. memberships: institution lookup (admin panels, member lists)
CREATE INDEX IF NOT EXISTS idx_memberships_institution_id
  ON memberships (institution_id);

-- 3. reviews: item lookup for dedup and history
CREATE INDEX IF NOT EXISTS idx_reviews_item_id
  ON reviews (item_id);

-- 4. reviews: created_at for time-range queries (dashboard, analytics)
CREATE INDEX IF NOT EXISTS idx_reviews_created_at
  ON reviews (created_at);

-- 5. study_sessions: completed sessions for dashboard aggregation
CREATE INDEX IF NOT EXISTS idx_study_sessions_completed
  ON study_sessions (student_id, completed_at)
  WHERE completed_at IS NOT NULL;

-- 6. flashcards: keyword_id lookup (keyword propagation, BKT)
CREATE INDEX IF NOT EXISTS idx_flashcards_keyword_id
  ON flashcards (keyword_id)
  WHERE deleted_at IS NULL;

-- 7. quiz_questions: keyword_id lookup (keyword propagation, BKT)
CREATE INDEX IF NOT EXISTS idx_quiz_questions_keyword_id
  ON quiz_questions (keyword_id)
  WHERE deleted_at IS NULL;

-- 8. subtopics: keyword_id lookup (BKT propagation across siblings)
CREATE INDEX IF NOT EXISTS idx_subtopics_keyword_id
  ON subtopics (keyword_id)
  WHERE deleted_at IS NULL;

-- 9. bkt_states: student + subtopic composite (upsert conflict target)
CREATE INDEX IF NOT EXISTS idx_bkt_states_student_subtopic
  ON bkt_states (student_id, subtopic_id);

-- 10. fsrs_states: student + flashcard composite (upsert conflict target)
CREATE INDEX IF NOT EXISTS idx_fsrs_states_student_flashcard
  ON fsrs_states (student_id, flashcard_id);

-- 11. keywords: summary_id lookup (content tree, keyword listing)
CREATE INDEX IF NOT EXISTS idx_keywords_summary_id
  ON keywords (summary_id)
  WHERE deleted_at IS NULL;

-- 12. chunks: summary_id + deleted_at for RAG pipeline (delete + re-insert)
CREATE INDEX IF NOT EXISTS idx_chunks_summary_not_deleted
  ON chunks (summary_id)
  WHERE deleted_at IS NULL;

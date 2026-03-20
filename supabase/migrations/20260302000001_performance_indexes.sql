-- ============================================================
-- Migration: Performance Indexes for High-Read Tables
-- Date: 2026-03-02
-- Purpose: Add composite/partial indexes to avoid sequential
--          scans as tables grow to millions of rows.
--
-- Context: crud-factory.ts generates queries like:
--   WHERE summary_id = x AND is_active = true AND deleted_at IS NULL
--   PostgreSQL only auto-creates indexes for PK and UNIQUE.
--   These filtered queries have NO index → sequential scan.
--
-- Impact estimate (at 20M rows per table):
--   Without index: 2-5 seconds per query (sequential scan)
--   With index:    2-5 milliseconds per query (index lookup)
--
-- NOTE: Cannot use CONCURRENTLY inside a transaction.
-- Supabase migration runner auto-wraps each file in a transaction.
-- For production tables with heavy traffic, consider running
-- these manually with CONCURRENTLY outside a transaction.
-- ============================================================

-- ═══════════════════════════════════════════════════════════════
-- 1. CONTENT TABLES (professor-created, read by all students)
--    Pattern: WHERE <parent_key> = x AND is_active = true AND deleted_at IS NULL
-- ═══════════════════════════════════════════════════════════════

-- flashcards: LIST by summary_id (filtered to active, not deleted)
-- Used by: StudentSummariesView, FlashcardReviewer, topic-progress endpoint
CREATE INDEX IF NOT EXISTS idx_flashcards_summary_active
  ON flashcards (summary_id)
  WHERE is_active = true AND deleted_at IS NULL;

-- quiz_questions: LIST by summary_id (filtered to active, not deleted)
-- Used by: QuizTaker, quiz generation
CREATE INDEX IF NOT EXISTS idx_quiz_questions_summary_active
  ON quiz_questions (summary_id)
  WHERE is_active = true AND deleted_at IS NULL;

-- summaries: LIST by topic_id (filtered to published, active, not deleted)
-- Used by: TopicSummariesView, StudentSummariesView, topic-progress endpoint
CREATE INDEX IF NOT EXISTS idx_summaries_topic_published
  ON summaries (topic_id)
  WHERE status = 'published' AND is_active = true AND deleted_at IS NULL;

-- videos: LIST by summary_id (filtered to active, not deleted)
-- Used by: VideoPlayer, summary detail view
CREATE INDEX IF NOT EXISTS idx_videos_summary_active
  ON videos (summary_id)
  WHERE is_active = true AND deleted_at IS NULL;

-- quizzes: LIST by summary_id (filtered to active, not deleted)
CREATE INDEX IF NOT EXISTS idx_quizzes_summary_active
  ON quizzes (summary_id)
  WHERE is_active = true AND deleted_at IS NULL;


-- ═══════════════════════════════════════════════════════════════
-- 2. STUDENT STATE TABLES (per-student, high row count)
-- ═══════════════════════════════════════════════════════════════

-- reading_states: already has UNIQUE(student_id, summary_id) → implicit index ✓
-- BUT: batch queries use .in("summary_id", [...]) without student_id first
-- Need a separate index on summary_id for the topic-progress endpoint
CREATE INDEX IF NOT EXISTS idx_reading_states_summary
  ON reading_states (summary_id);

-- fsrs_states: study queue query = WHERE student_id = x AND due_at < NOW()
-- Also filtered by state for queue prioritization
CREATE INDEX IF NOT EXISTS idx_fsrs_states_student_due
  ON fsrs_states (student_id, due_at);

-- bkt_states: mastery lookup = WHERE student_id = x
-- Optional filter by subtopic_id
CREATE INDEX IF NOT EXISTS idx_bkt_states_student
  ON bkt_states (student_id);


-- ═══════════════════════════════════════════════════════════════
-- 3. ACTIVITY & SESSION TABLES (append-heavy, read by dashboard)
-- ═══════════════════════════════════════════════════════════════

-- reviews: LIST by session_id (used by review history + trigger)
CREATE INDEX IF NOT EXISTS idx_reviews_session
  ON reviews (session_id);

-- study_sessions: LIST by student_id (student-scoped via scopeToUser)
CREATE INDEX IF NOT EXISTS idx_study_sessions_student
  ON study_sessions (student_id);

-- daily_activities: dashboard query = WHERE student_id = x ORDER BY activity_date
-- Also has UNIQUE(student_id, activity_date) → implicit index ✓
-- But adding explicit compound for range queries (FROM/TO date filters)
CREATE INDEX IF NOT EXISTS idx_daily_activities_student_date
  ON daily_activities (student_id, activity_date DESC);

-- quiz_attempts: LIST by student_id + optional quiz_question_id or session_id
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_student
  ON quiz_attempts (student_id);


-- ═══════════════════════════════════════════════════════════════
-- 4. STUDENT NOTES (per-student, scoped by parent)
-- ═══════════════════════════════════════════════════════════════

-- kw_student_notes: LIST by keyword_id + student_id
CREATE INDEX IF NOT EXISTS idx_kw_student_notes_keyword_student
  ON kw_student_notes (keyword_id, student_id)
  WHERE deleted_at IS NULL;

-- text_annotations: LIST by summary_id + student_id
CREATE INDEX IF NOT EXISTS idx_text_annotations_summary_student
  ON text_annotations (summary_id, student_id)
  WHERE deleted_at IS NULL;

-- video_notes: LIST by video_id + student_id
CREATE INDEX IF NOT EXISTS idx_video_notes_video_student
  ON video_notes (video_id, student_id)
  WHERE deleted_at IS NULL;

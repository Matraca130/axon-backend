-- ============================================================================
-- Migration: RLS performance — wrap user_institution_ids() in (SELECT …)
-- Date: 2026-04-07
-- Supersedes (policies only, not structure): 20260319000004_rls_content_tables.sql
-- Related: PR #209 (fix/content-tree-timeout)
-- ADR: ADR-002-rls-performance-strategy.md
--
-- ─── WHY ────────────────────────────────────────────────────────────────────
-- The policies created in 20260319000004 call `user_institution_ids()`
-- directly inside the USING/WITH CHECK clauses. Even though the function
-- is declared STABLE, Postgres re-evaluates it for every row scanned when
-- it's called inline, because the planner cannot prove that the value is
-- constant across the statement without the `(SELECT …)` wrapper.
--
-- The `(SELECT …)` wrapper converts the function call into an InitPlan
-- node that executes exactly once per statement and caches the result,
-- which is then used by the outer comparison as a simple array match.
--
-- See: https://supabase.com/docs/guides/database/postgres/row-level-security#call-functions-with-select
--
-- This migration:
--   • DROPs and RE-CREATEs all 68 member-scoped policies (4 CRUD × 17 tables)
--   • Leaves the `*_service_role_all` policies UNTOUCHED (they don't call
--     user_institution_ids so they have no perf issue)
--   • Preserves the same logical predicate — this is a pure perf fix,
--     no behavior changes, no security changes
--   • Is idempotent: safe to run again (drops existing before creating)
--
-- Expected impact: 100x–1000x speedup on queries against these tables
-- for authenticated users (per Supabase docs).
--
-- Tables affected (17):
--   courses, semesters, sections, topics, summaries,
--   chunks, keywords, subtopics, keyword_connections, flashcards,
--   quizzes, quiz_questions, videos,
--   models_3d, model_3d_pins, model_layers, model_parts
-- ============================================================================

BEGIN;

-- ══════════════════════════════════════════════════════════════════════════════
-- 1. COURSES — direct institution_id
-- ══════════════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "courses_members_select" ON courses;
DROP POLICY IF EXISTS "courses_members_insert" ON courses;
DROP POLICY IF EXISTS "courses_members_update" ON courses;
DROP POLICY IF EXISTS "courses_members_delete" ON courses;

CREATE POLICY "courses_members_select" ON courses
  FOR SELECT USING (institution_id = ANY((SELECT public.user_institution_ids())::uuid[]));
CREATE POLICY "courses_members_insert" ON courses
  FOR INSERT WITH CHECK (institution_id = ANY((SELECT public.user_institution_ids())::uuid[]));
CREATE POLICY "courses_members_update" ON courses
  FOR UPDATE USING (institution_id = ANY((SELECT public.user_institution_ids())::uuid[]));
CREATE POLICY "courses_members_delete" ON courses
  FOR DELETE USING (institution_id = ANY((SELECT public.user_institution_ids())::uuid[]));

-- ══════════════════════════════════════════════════════════════════════════════
-- 2. SEMESTERS — via courses.institution_id
-- ══════════════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "semesters_members_select" ON semesters;
DROP POLICY IF EXISTS "semesters_members_insert" ON semesters;
DROP POLICY IF EXISTS "semesters_members_update" ON semesters;
DROP POLICY IF EXISTS "semesters_members_delete" ON semesters;

CREATE POLICY "semesters_members_select" ON semesters
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM courses c
      WHERE c.id = semesters.course_id
        AND c.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "semesters_members_insert" ON semesters
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM courses c
      WHERE c.id = semesters.course_id
        AND c.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "semesters_members_update" ON semesters
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM courses c
      WHERE c.id = semesters.course_id
        AND c.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "semesters_members_delete" ON semesters
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM courses c
      WHERE c.id = semesters.course_id
        AND c.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );

-- ══════════════════════════════════════════════════════════════════════════════
-- 3. SECTIONS — via semesters -> courses
-- ══════════════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "sections_members_select" ON sections;
DROP POLICY IF EXISTS "sections_members_insert" ON sections;
DROP POLICY IF EXISTS "sections_members_update" ON sections;
DROP POLICY IF EXISTS "sections_members_delete" ON sections;

CREATE POLICY "sections_members_select" ON sections
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM semesters s
      JOIN courses c ON c.id = s.course_id
      WHERE s.id = sections.semester_id
        AND c.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "sections_members_insert" ON sections
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM semesters s
      JOIN courses c ON c.id = s.course_id
      WHERE s.id = sections.semester_id
        AND c.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "sections_members_update" ON sections
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM semesters s
      JOIN courses c ON c.id = s.course_id
      WHERE s.id = sections.semester_id
        AND c.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "sections_members_delete" ON sections
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM semesters s
      JOIN courses c ON c.id = s.course_id
      WHERE s.id = sections.semester_id
        AND c.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );

-- ══════════════════════════════════════════════════════════════════════════════
-- 4. TOPICS — via sections -> semesters -> courses
-- ══════════════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "topics_members_select" ON topics;
DROP POLICY IF EXISTS "topics_members_insert" ON topics;
DROP POLICY IF EXISTS "topics_members_update" ON topics;
DROP POLICY IF EXISTS "topics_members_delete" ON topics;

CREATE POLICY "topics_members_select" ON topics
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM sections sec
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE sec.id = topics.section_id
        AND c.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "topics_members_insert" ON topics
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM sections sec
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE sec.id = topics.section_id
        AND c.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "topics_members_update" ON topics
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM sections sec
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE sec.id = topics.section_id
        AND c.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "topics_members_delete" ON topics
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM sections sec
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE sec.id = topics.section_id
        AND c.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );

-- ══════════════════════════════════════════════════════════════════════════════
-- 5. SUMMARIES — direct institution_id (denormalized)
-- NOTE: The INSERT policy was the only one that used the 4-table EXISTS cascade.
-- Preserving it as-is, just wrapped.
-- ══════════════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "summaries_members_select" ON summaries;
DROP POLICY IF EXISTS "summaries_members_insert" ON summaries;
DROP POLICY IF EXISTS "summaries_members_update" ON summaries;
DROP POLICY IF EXISTS "summaries_members_delete" ON summaries;

CREATE POLICY "summaries_members_select" ON summaries
  FOR SELECT USING (institution_id = ANY((SELECT public.user_institution_ids())::uuid[]));
CREATE POLICY "summaries_members_insert" ON summaries
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM topics t
      JOIN sections sec ON sec.id = t.section_id
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE t.id = summaries.topic_id
        AND c.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "summaries_members_update" ON summaries
  FOR UPDATE USING (institution_id = ANY((SELECT public.user_institution_ids())::uuid[]));
CREATE POLICY "summaries_members_delete" ON summaries
  FOR DELETE USING (institution_id = ANY((SELECT public.user_institution_ids())::uuid[]));

-- ══════════════════════════════════════════════════════════════════════════════
-- 6. CHUNKS — via summaries
-- ══════════════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "chunks_members_select" ON chunks;
DROP POLICY IF EXISTS "chunks_members_insert" ON chunks;
DROP POLICY IF EXISTS "chunks_members_update" ON chunks;
DROP POLICY IF EXISTS "chunks_members_delete" ON chunks;

CREATE POLICY "chunks_members_select" ON chunks
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = chunks.summary_id
        AND s.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "chunks_members_insert" ON chunks
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = chunks.summary_id
        AND s.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "chunks_members_update" ON chunks
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = chunks.summary_id
        AND s.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "chunks_members_delete" ON chunks
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = chunks.summary_id
        AND s.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );

-- ══════════════════════════════════════════════════════════════════════════════
-- 7. KEYWORDS — via summaries
-- ══════════════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "keywords_members_select" ON keywords;
DROP POLICY IF EXISTS "keywords_members_insert" ON keywords;
DROP POLICY IF EXISTS "keywords_members_update" ON keywords;
DROP POLICY IF EXISTS "keywords_members_delete" ON keywords;

CREATE POLICY "keywords_members_select" ON keywords
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = keywords.summary_id
        AND s.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "keywords_members_insert" ON keywords
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = keywords.summary_id
        AND s.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "keywords_members_update" ON keywords
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = keywords.summary_id
        AND s.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "keywords_members_delete" ON keywords
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = keywords.summary_id
        AND s.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );

-- ══════════════════════════════════════════════════════════════════════════════
-- 8. SUBTOPICS — via keywords -> summaries
-- ══════════════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "subtopics_members_select" ON subtopics;
DROP POLICY IF EXISTS "subtopics_members_insert" ON subtopics;
DROP POLICY IF EXISTS "subtopics_members_update" ON subtopics;
DROP POLICY IF EXISTS "subtopics_members_delete" ON subtopics;

CREATE POLICY "subtopics_members_select" ON subtopics
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM keywords k
      JOIN summaries s ON s.id = k.summary_id
      WHERE k.id = subtopics.keyword_id
        AND s.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "subtopics_members_insert" ON subtopics
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM keywords k
      JOIN summaries s ON s.id = k.summary_id
      WHERE k.id = subtopics.keyword_id
        AND s.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "subtopics_members_update" ON subtopics
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM keywords k
      JOIN summaries s ON s.id = k.summary_id
      WHERE k.id = subtopics.keyword_id
        AND s.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "subtopics_members_delete" ON subtopics
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM keywords k
      JOIN summaries s ON s.id = k.summary_id
      WHERE k.id = subtopics.keyword_id
        AND s.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );

-- ══════════════════════════════════════════════════════════════════════════════
-- 9. KEYWORD_CONNECTIONS — via keywords -> summaries
-- ══════════════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "kw_conn_members_select" ON keyword_connections;
DROP POLICY IF EXISTS "kw_conn_members_insert" ON keyword_connections;
DROP POLICY IF EXISTS "kw_conn_members_update" ON keyword_connections;
DROP POLICY IF EXISTS "kw_conn_members_delete" ON keyword_connections;

CREATE POLICY "kw_conn_members_select" ON keyword_connections
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM keywords k
      JOIN summaries s ON s.id = k.summary_id
      WHERE k.id = keyword_connections.keyword_a_id
        AND s.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "kw_conn_members_insert" ON keyword_connections
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM keywords k
      JOIN summaries s ON s.id = k.summary_id
      WHERE k.id = keyword_connections.keyword_a_id
        AND s.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "kw_conn_members_update" ON keyword_connections
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM keywords k
      JOIN summaries s ON s.id = k.summary_id
      WHERE k.id = keyword_connections.keyword_a_id
        AND s.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "kw_conn_members_delete" ON keyword_connections
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM keywords k
      JOIN summaries s ON s.id = k.summary_id
      WHERE k.id = keyword_connections.keyword_a_id
        AND s.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );

-- ══════════════════════════════════════════════════════════════════════════════
-- 10. FLASHCARDS — via summaries
-- ══════════════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "flashcards_members_select" ON flashcards;
DROP POLICY IF EXISTS "flashcards_members_insert" ON flashcards;
DROP POLICY IF EXISTS "flashcards_members_update" ON flashcards;
DROP POLICY IF EXISTS "flashcards_members_delete" ON flashcards;

CREATE POLICY "flashcards_members_select" ON flashcards
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = flashcards.summary_id
        AND s.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "flashcards_members_insert" ON flashcards
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = flashcards.summary_id
        AND s.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "flashcards_members_update" ON flashcards
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = flashcards.summary_id
        AND s.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "flashcards_members_delete" ON flashcards
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = flashcards.summary_id
        AND s.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );

-- ══════════════════════════════════════════════════════════════════════════════
-- 11. QUIZZES — via summaries
-- ══════════════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "quizzes_members_select" ON quizzes;
DROP POLICY IF EXISTS "quizzes_members_insert" ON quizzes;
DROP POLICY IF EXISTS "quizzes_members_update" ON quizzes;
DROP POLICY IF EXISTS "quizzes_members_delete" ON quizzes;

CREATE POLICY "quizzes_members_select" ON quizzes
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = quizzes.summary_id
        AND s.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "quizzes_members_insert" ON quizzes
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = quizzes.summary_id
        AND s.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "quizzes_members_update" ON quizzes
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = quizzes.summary_id
        AND s.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "quizzes_members_delete" ON quizzes
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = quizzes.summary_id
        AND s.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );

-- ══════════════════════════════════════════════════════════════════════════════
-- 12. QUIZ_QUESTIONS — via summaries
-- ══════════════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "quiz_q_members_select" ON quiz_questions;
DROP POLICY IF EXISTS "quiz_q_members_insert" ON quiz_questions;
DROP POLICY IF EXISTS "quiz_q_members_update" ON quiz_questions;
DROP POLICY IF EXISTS "quiz_q_members_delete" ON quiz_questions;

CREATE POLICY "quiz_q_members_select" ON quiz_questions
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = quiz_questions.summary_id
        AND s.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "quiz_q_members_insert" ON quiz_questions
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = quiz_questions.summary_id
        AND s.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "quiz_q_members_update" ON quiz_questions
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = quiz_questions.summary_id
        AND s.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "quiz_q_members_delete" ON quiz_questions
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = quiz_questions.summary_id
        AND s.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );

-- ══════════════════════════════════════════════════════════════════════════════
-- 13. VIDEOS — via summaries
-- ══════════════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "videos_members_select" ON videos;
DROP POLICY IF EXISTS "videos_members_insert" ON videos;
DROP POLICY IF EXISTS "videos_members_update" ON videos;
DROP POLICY IF EXISTS "videos_members_delete" ON videos;

CREATE POLICY "videos_members_select" ON videos
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = videos.summary_id
        AND s.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "videos_members_insert" ON videos
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = videos.summary_id
        AND s.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "videos_members_update" ON videos
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = videos.summary_id
        AND s.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "videos_members_delete" ON videos
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = videos.summary_id
        AND s.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );

-- ══════════════════════════════════════════════════════════════════════════════
-- 14. MODELS_3D — via topics -> sections -> semesters -> courses (4-level)
-- ══════════════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "models_3d_members_select" ON models_3d;
DROP POLICY IF EXISTS "models_3d_members_insert" ON models_3d;
DROP POLICY IF EXISTS "models_3d_members_update" ON models_3d;
DROP POLICY IF EXISTS "models_3d_members_delete" ON models_3d;

CREATE POLICY "models_3d_members_select" ON models_3d
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM topics t
      JOIN sections sec ON sec.id = t.section_id
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE t.id = models_3d.topic_id
        AND c.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "models_3d_members_insert" ON models_3d
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM topics t
      JOIN sections sec ON sec.id = t.section_id
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE t.id = models_3d.topic_id
        AND c.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "models_3d_members_update" ON models_3d
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM topics t
      JOIN sections sec ON sec.id = t.section_id
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE t.id = models_3d.topic_id
        AND c.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "models_3d_members_delete" ON models_3d
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM topics t
      JOIN sections sec ON sec.id = t.section_id
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE t.id = models_3d.topic_id
        AND c.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );

-- ══════════════════════════════════════════════════════════════════════════════
-- 15. MODEL_3D_PINS — via models_3d -> topics -> sections -> semesters -> courses (5-level)
-- ══════════════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "model_pins_members_select" ON model_3d_pins;
DROP POLICY IF EXISTS "model_pins_members_insert" ON model_3d_pins;
DROP POLICY IF EXISTS "model_pins_members_update" ON model_3d_pins;
DROP POLICY IF EXISTS "model_pins_members_delete" ON model_3d_pins;

CREATE POLICY "model_pins_members_select" ON model_3d_pins
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM models_3d m
      JOIN topics t ON t.id = m.topic_id
      JOIN sections sec ON sec.id = t.section_id
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE m.id = model_3d_pins.model_id
        AND c.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "model_pins_members_insert" ON model_3d_pins
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM models_3d m
      JOIN topics t ON t.id = m.topic_id
      JOIN sections sec ON sec.id = t.section_id
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE m.id = model_3d_pins.model_id
        AND c.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "model_pins_members_update" ON model_3d_pins
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM models_3d m
      JOIN topics t ON t.id = m.topic_id
      JOIN sections sec ON sec.id = t.section_id
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE m.id = model_3d_pins.model_id
        AND c.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "model_pins_members_delete" ON model_3d_pins
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM models_3d m
      JOIN topics t ON t.id = m.topic_id
      JOIN sections sec ON sec.id = t.section_id
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE m.id = model_3d_pins.model_id
        AND c.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );

-- ══════════════════════════════════════════════════════════════════════════════
-- 16. MODEL_LAYERS — via models_3d -> topics -> sections -> semesters -> courses
-- ══════════════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "model_layers_members_select" ON model_layers;
DROP POLICY IF EXISTS "model_layers_members_insert" ON model_layers;
DROP POLICY IF EXISTS "model_layers_members_update" ON model_layers;
DROP POLICY IF EXISTS "model_layers_members_delete" ON model_layers;

CREATE POLICY "model_layers_members_select" ON model_layers
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM models_3d m
      JOIN topics t ON t.id = m.topic_id
      JOIN sections sec ON sec.id = t.section_id
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE m.id = model_layers.model_id
        AND c.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "model_layers_members_insert" ON model_layers
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM models_3d m
      JOIN topics t ON t.id = m.topic_id
      JOIN sections sec ON sec.id = t.section_id
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE m.id = model_layers.model_id
        AND c.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "model_layers_members_update" ON model_layers
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM models_3d m
      JOIN topics t ON t.id = m.topic_id
      JOIN sections sec ON sec.id = t.section_id
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE m.id = model_layers.model_id
        AND c.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "model_layers_members_delete" ON model_layers
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM models_3d m
      JOIN topics t ON t.id = m.topic_id
      JOIN sections sec ON sec.id = t.section_id
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE m.id = model_layers.model_id
        AND c.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );

-- ══════════════════════════════════════════════════════════════════════════════
-- 17. MODEL_PARTS — via models_3d -> topics -> sections -> semesters -> courses
-- ══════════════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "model_parts_members_select" ON model_parts;
DROP POLICY IF EXISTS "model_parts_members_insert" ON model_parts;
DROP POLICY IF EXISTS "model_parts_members_update" ON model_parts;
DROP POLICY IF EXISTS "model_parts_members_delete" ON model_parts;

CREATE POLICY "model_parts_members_select" ON model_parts
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM models_3d m
      JOIN topics t ON t.id = m.topic_id
      JOIN sections sec ON sec.id = t.section_id
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE m.id = model_parts.model_id
        AND c.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "model_parts_members_insert" ON model_parts
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM models_3d m
      JOIN topics t ON t.id = m.topic_id
      JOIN sections sec ON sec.id = t.section_id
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE m.id = model_parts.model_id
        AND c.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "model_parts_members_update" ON model_parts
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM models_3d m
      JOIN topics t ON t.id = m.topic_id
      JOIN sections sec ON sec.id = t.section_id
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE m.id = model_parts.model_id
        AND c.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );
CREATE POLICY "model_parts_members_delete" ON model_parts
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM models_3d m
      JOIN topics t ON t.id = m.topic_id
      JOIN sections sec ON sec.id = t.section_id
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE m.id = model_parts.model_id
        AND c.institution_id = ANY((SELECT public.user_institution_ids())::uuid[])
    )
  );

COMMIT;

-- ============================================================================
-- Sanity check: after this migration runs, every member-scoped policy
-- should contain the substring "(SELECT public.user_institution_ids())".
-- Run this manually to verify:
--
--   SELECT tablename, policyname
--   FROM pg_policies
--   WHERE schemaname = 'public'
--     AND policyname LIKE '%members%'
--     AND qual NOT LIKE '%(SELECT%user_institution_ids%'
--     AND with_check NOT LIKE '%(SELECT%user_institution_ids%';
--
-- Expected: 0 rows.
-- ============================================================================

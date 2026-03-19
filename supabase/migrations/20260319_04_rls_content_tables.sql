-- ============================================================================
-- Migration: RLS policies for content hierarchy tables
-- Part of D3 RLS rollout (S11)
-- Date: 2026-03-19
--
-- Tables covered (9):
--   courses, semesters, sections, topics, summaries,
--   chunks, keywords, subtopics, keyword_connections
--
-- Tables SKIPPED (already have RLS):
--   summary_blocks (20260228_02), video_views (20260224_02)
--
-- Policy pattern:
--   members_select  — SELECT for institution members
--   members_insert  — INSERT for institution members
--   members_update  — UPDATE for institution members
--   members_delete  — DELETE for institution members
--   service_role_all — ALL for service_role (Edge Functions via getAdminClient)
--
-- The crud-factory uses the user's Supabase client (db) for all CRUD,
-- so authenticated users need read AND write policies.
-- ============================================================================

-- ══════════════════════════════════════════════════════════════════════════════
-- 1. COURSES — has institution_id directly
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE courses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "courses_members_select" ON courses
  FOR SELECT USING (institution_id = ANY(auth.user_institution_ids()));

CREATE POLICY "courses_members_insert" ON courses
  FOR INSERT WITH CHECK (institution_id = ANY(auth.user_institution_ids()));

CREATE POLICY "courses_members_update" ON courses
  FOR UPDATE USING (institution_id = ANY(auth.user_institution_ids()));

CREATE POLICY "courses_members_delete" ON courses
  FOR DELETE USING (institution_id = ANY(auth.user_institution_ids()));

CREATE POLICY "courses_service_role_all" ON courses
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- 2. SEMESTERS — FK: course_id -> courses.institution_id
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE semesters ENABLE ROW LEVEL SECURITY;

CREATE POLICY "semesters_members_select" ON semesters
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM courses c
      WHERE c.id = semesters.course_id
        AND c.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "semesters_members_insert" ON semesters
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM courses c
      WHERE c.id = semesters.course_id
        AND c.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "semesters_members_update" ON semesters
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM courses c
      WHERE c.id = semesters.course_id
        AND c.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "semesters_members_delete" ON semesters
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM courses c
      WHERE c.id = semesters.course_id
        AND c.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "semesters_service_role_all" ON semesters
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- 3. SECTIONS — FK: semester_id -> semesters -> courses.institution_id
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE sections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sections_members_select" ON sections
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM semesters s
      JOIN courses c ON c.id = s.course_id
      WHERE s.id = sections.semester_id
        AND c.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "sections_members_insert" ON sections
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM semesters s
      JOIN courses c ON c.id = s.course_id
      WHERE s.id = sections.semester_id
        AND c.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "sections_members_update" ON sections
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM semesters s
      JOIN courses c ON c.id = s.course_id
      WHERE s.id = sections.semester_id
        AND c.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "sections_members_delete" ON sections
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM semesters s
      JOIN courses c ON c.id = s.course_id
      WHERE s.id = sections.semester_id
        AND c.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "sections_service_role_all" ON sections
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- 4. TOPICS — FK: section_id -> sections -> semesters -> courses
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE topics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "topics_members_select" ON topics
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM sections sec
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE sec.id = topics.section_id
        AND c.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "topics_members_insert" ON topics
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM sections sec
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE sec.id = topics.section_id
        AND c.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "topics_members_update" ON topics
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM sections sec
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE sec.id = topics.section_id
        AND c.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "topics_members_delete" ON topics
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM sections sec
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE sec.id = topics.section_id
        AND c.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "topics_service_role_all" ON topics
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- 5. SUMMARIES — has denormalized institution_id (20260304_06)
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE summaries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "summaries_members_select" ON summaries
  FOR SELECT USING (institution_id = ANY(auth.user_institution_ids()));

CREATE POLICY "summaries_members_insert" ON summaries
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM topics t
      JOIN sections sec ON sec.id = t.section_id
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE t.id = summaries.topic_id
        AND c.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "summaries_members_update" ON summaries
  FOR UPDATE USING (institution_id = ANY(auth.user_institution_ids()));

CREATE POLICY "summaries_members_delete" ON summaries
  FOR DELETE USING (institution_id = ANY(auth.user_institution_ids()));

CREATE POLICY "summaries_service_role_all" ON summaries
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- 6. CHUNKS — FK: summary_id -> summaries (has institution_id)
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE chunks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "chunks_members_select" ON chunks
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = chunks.summary_id
        AND s.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "chunks_members_insert" ON chunks
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = chunks.summary_id
        AND s.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "chunks_members_update" ON chunks
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = chunks.summary_id
        AND s.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "chunks_members_delete" ON chunks
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = chunks.summary_id
        AND s.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "chunks_service_role_all" ON chunks
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- 7. KEYWORDS — FK: summary_id -> summaries (has institution_id)
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE keywords ENABLE ROW LEVEL SECURITY;

CREATE POLICY "keywords_members_select" ON keywords
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = keywords.summary_id
        AND s.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "keywords_members_insert" ON keywords
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = keywords.summary_id
        AND s.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "keywords_members_update" ON keywords
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = keywords.summary_id
        AND s.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "keywords_members_delete" ON keywords
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = keywords.summary_id
        AND s.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "keywords_service_role_all" ON keywords
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- 8. SUBTOPICS — FK: keyword_id -> keywords -> summaries
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE subtopics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "subtopics_members_select" ON subtopics
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM keywords k
      JOIN summaries s ON s.id = k.summary_id
      WHERE k.id = subtopics.keyword_id
        AND s.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "subtopics_members_insert" ON subtopics
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM keywords k
      JOIN summaries s ON s.id = k.summary_id
      WHERE k.id = subtopics.keyword_id
        AND s.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "subtopics_members_update" ON subtopics
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM keywords k
      JOIN summaries s ON s.id = k.summary_id
      WHERE k.id = subtopics.keyword_id
        AND s.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "subtopics_members_delete" ON subtopics
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM keywords k
      JOIN summaries s ON s.id = k.summary_id
      WHERE k.id = subtopics.keyword_id
        AND s.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "subtopics_service_role_all" ON subtopics
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- 9. KEYWORD_CONNECTIONS — FK: keyword_a_id -> keywords -> summaries
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE keyword_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "kw_conn_members_select" ON keyword_connections
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM keywords k
      JOIN summaries s ON s.id = k.summary_id
      WHERE k.id = keyword_connections.keyword_a_id
        AND s.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "kw_conn_members_insert" ON keyword_connections
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM keywords k
      JOIN summaries s ON s.id = k.summary_id
      WHERE k.id = keyword_connections.keyword_a_id
        AND s.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "kw_conn_members_update" ON keyword_connections
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM keywords k
      JOIN summaries s ON s.id = k.summary_id
      WHERE k.id = keyword_connections.keyword_a_id
        AND s.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "kw_conn_members_delete" ON keyword_connections
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM keywords k
      JOIN summaries s ON s.id = k.summary_id
      WHERE k.id = keyword_connections.keyword_a_id
        AND s.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "kw_conn_service_role_all" ON keyword_connections
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- 10. FLASHCARDS — has institution_id (denormalized via summary trigger chain)
--     Actually flashcards FK to summary_id -> summaries (which has institution_id)
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE flashcards ENABLE ROW LEVEL SECURITY;

CREATE POLICY "flashcards_members_select" ON flashcards
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = flashcards.summary_id
        AND s.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "flashcards_members_insert" ON flashcards
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = flashcards.summary_id
        AND s.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "flashcards_members_update" ON flashcards
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = flashcards.summary_id
        AND s.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "flashcards_members_delete" ON flashcards
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = flashcards.summary_id
        AND s.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "flashcards_service_role_all" ON flashcards
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- 11. QUIZZES — FK: summary_id -> summaries
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE quizzes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "quizzes_members_select" ON quizzes
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = quizzes.summary_id
        AND s.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "quizzes_members_insert" ON quizzes
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = quizzes.summary_id
        AND s.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "quizzes_members_update" ON quizzes
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = quizzes.summary_id
        AND s.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "quizzes_members_delete" ON quizzes
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = quizzes.summary_id
        AND s.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "quizzes_service_role_all" ON quizzes
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- 12. QUIZ_QUESTIONS — FK: summary_id -> summaries
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE quiz_questions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "quiz_q_members_select" ON quiz_questions
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = quiz_questions.summary_id
        AND s.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "quiz_q_members_insert" ON quiz_questions
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = quiz_questions.summary_id
        AND s.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "quiz_q_members_update" ON quiz_questions
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = quiz_questions.summary_id
        AND s.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "quiz_q_members_delete" ON quiz_questions
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = quiz_questions.summary_id
        AND s.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "quiz_q_service_role_all" ON quiz_questions
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- 13. VIDEOS — FK: summary_id -> summaries
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE videos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "videos_members_select" ON videos
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = videos.summary_id
        AND s.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "videos_members_insert" ON videos
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = videos.summary_id
        AND s.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "videos_members_update" ON videos
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = videos.summary_id
        AND s.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "videos_members_delete" ON videos
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = videos.summary_id
        AND s.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "videos_service_role_all" ON videos
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- 14. MODELS_3D — FK: topic_id -> topics -> sections -> semesters -> courses
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE models_3d ENABLE ROW LEVEL SECURITY;

CREATE POLICY "models_3d_members_select" ON models_3d
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM topics t
      JOIN sections sec ON sec.id = t.section_id
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE t.id = models_3d.topic_id
        AND c.institution_id = ANY(auth.user_institution_ids())
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
        AND c.institution_id = ANY(auth.user_institution_ids())
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
        AND c.institution_id = ANY(auth.user_institution_ids())
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
        AND c.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "models_3d_service_role_all" ON models_3d
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- 15. MODEL_3D_PINS — FK: model_id -> models_3d -> topics -> ... -> courses
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE model_3d_pins ENABLE ROW LEVEL SECURITY;

CREATE POLICY "model_pins_members_select" ON model_3d_pins
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM models_3d m
      JOIN topics t ON t.id = m.topic_id
      JOIN sections sec ON sec.id = t.section_id
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE m.id = model_3d_pins.model_id
        AND c.institution_id = ANY(auth.user_institution_ids())
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
        AND c.institution_id = ANY(auth.user_institution_ids())
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
        AND c.institution_id = ANY(auth.user_institution_ids())
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
        AND c.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "model_pins_service_role_all" ON model_3d_pins
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- 16. MODEL_LAYERS — FK: model_id -> models_3d -> topics -> ... -> courses
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE model_layers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "model_layers_members_select" ON model_layers
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM models_3d m
      JOIN topics t ON t.id = m.topic_id
      JOIN sections sec ON sec.id = t.section_id
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE m.id = model_layers.model_id
        AND c.institution_id = ANY(auth.user_institution_ids())
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
        AND c.institution_id = ANY(auth.user_institution_ids())
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
        AND c.institution_id = ANY(auth.user_institution_ids())
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
        AND c.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "model_layers_service_role_all" ON model_layers
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- 17. MODEL_PARTS — FK: model_id -> models_3d -> topics -> ... -> courses
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE model_parts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "model_parts_members_select" ON model_parts
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM models_3d m
      JOIN topics t ON t.id = m.topic_id
      JOIN sections sec ON sec.id = t.section_id
      JOIN semesters s ON s.id = sec.semester_id
      JOIN courses c ON c.id = s.course_id
      WHERE m.id = model_parts.model_id
        AND c.institution_id = ANY(auth.user_institution_ids())
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
        AND c.institution_id = ANY(auth.user_institution_ids())
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
        AND c.institution_id = ANY(auth.user_institution_ids())
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
        AND c.institution_id = ANY(auth.user_institution_ids())
    )
  );

CREATE POLICY "model_parts_service_role_all" ON model_parts
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- Verification
-- ══════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_tables TEXT[] := ARRAY[
    'courses', 'semesters', 'sections', 'topics', 'summaries',
    'chunks', 'keywords', 'subtopics', 'keyword_connections',
    'flashcards', 'quizzes', 'quiz_questions', 'videos',
    'models_3d', 'model_3d_pins', 'model_layers', 'model_parts'
  ];
  v_table TEXT;
  v_rls BOOLEAN;
  v_policy_count INT;
BEGIN
  FOREACH v_table IN ARRAY v_tables LOOP
    SELECT relrowsecurity INTO v_rls
    FROM pg_class WHERE relname = v_table AND relnamespace = 'public'::regnamespace;

    SELECT count(*) INTO v_policy_count
    FROM pg_policies WHERE tablename = v_table;

    IF v_rls THEN
      RAISE NOTICE '[OK] % — RLS enabled, % policies', v_table, v_policy_count;
    ELSE
      RAISE WARNING '[FAIL] % — RLS NOT enabled!', v_table;
    END IF;
  END LOOP;
END; $$;

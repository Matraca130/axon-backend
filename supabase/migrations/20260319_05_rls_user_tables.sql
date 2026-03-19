-- ============================================================================
-- Migration: RLS policies for user-scoped and gamification tables
-- Part of D3 RLS rollout (S11)
-- Date: 2026-03-19
--
-- User-scoped tables (use db/user client, need full CRUD policies):
--   reviews, quiz_attempts, study_sessions, study_plans,
--   study_plan_tasks, fsrs_states, bkt_states,
--   kw_student_notes, text_annotations, video_notes,
--   model_3d_notes, daily_activities
--
-- Gamification tables (writes via getAdminClient, reads via db):
--   student_xp, xp_transactions, badge_definitions, student_badges
--
-- Policy patterns:
--   user-scoped: own_select/own_insert/own_update/own_delete + service_role_all
--   gamification: own_select (read own data) + service_role_all (writes via admin)
-- ============================================================================

-- ══════════════════════════════════════════════════════════════════════════════
-- 1. REVIEWS — scoped via study_sessions.student_id (reviews has no user_id column)
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;

CREATE POLICY "reviews_own_select" ON reviews
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM study_sessions ss
      WHERE ss.id = reviews.session_id AND ss.student_id = auth.uid()
    )
  );

CREATE POLICY "reviews_own_insert" ON reviews
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM study_sessions ss
      WHERE ss.id = reviews.session_id AND ss.student_id = auth.uid()
    )
  );

CREATE POLICY "reviews_own_update" ON reviews
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM study_sessions ss
      WHERE ss.id = reviews.session_id AND ss.student_id = auth.uid()
    )
  );

CREATE POLICY "reviews_own_delete" ON reviews
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM study_sessions ss
      WHERE ss.id = reviews.session_id AND ss.student_id = auth.uid()
    )
  );

CREATE POLICY "reviews_service_role_all" ON reviews
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- 2. QUIZ_ATTEMPTS — student_id scoped
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE quiz_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "quiz_att_own_select" ON quiz_attempts
  FOR SELECT USING (student_id = auth.uid());

CREATE POLICY "quiz_att_own_insert" ON quiz_attempts
  FOR INSERT WITH CHECK (student_id = auth.uid());

CREATE POLICY "quiz_att_own_update" ON quiz_attempts
  FOR UPDATE USING (student_id = auth.uid());

CREATE POLICY "quiz_att_own_delete" ON quiz_attempts
  FOR DELETE USING (student_id = auth.uid());

CREATE POLICY "quiz_att_service_role_all" ON quiz_attempts
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- 3. STUDY_SESSIONS — student_id scoped (crud-factory scopeToUser)
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE study_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "study_sess_own_select" ON study_sessions
  FOR SELECT USING (student_id = auth.uid());

CREATE POLICY "study_sess_own_insert" ON study_sessions
  FOR INSERT WITH CHECK (student_id = auth.uid());

CREATE POLICY "study_sess_own_update" ON study_sessions
  FOR UPDATE USING (student_id = auth.uid());

CREATE POLICY "study_sess_own_delete" ON study_sessions
  FOR DELETE USING (student_id = auth.uid());

CREATE POLICY "study_sess_service_role_all" ON study_sessions
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- 4. STUDY_PLANS — student_id scoped (crud-factory scopeToUser)
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE study_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "study_plans_own_select" ON study_plans
  FOR SELECT USING (student_id = auth.uid());

CREATE POLICY "study_plans_own_insert" ON study_plans
  FOR INSERT WITH CHECK (student_id = auth.uid());

CREATE POLICY "study_plans_own_update" ON study_plans
  FOR UPDATE USING (student_id = auth.uid());

CREATE POLICY "study_plans_own_delete" ON study_plans
  FOR DELETE USING (student_id = auth.uid());

CREATE POLICY "study_plans_service_role_all" ON study_plans
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- 5. STUDY_PLAN_TASKS — FK via study_plan_id -> study_plans (no direct user_id)
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE study_plan_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "spt_own_select" ON study_plan_tasks
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM study_plans sp
      WHERE sp.id = study_plan_tasks.study_plan_id
        AND sp.student_id = auth.uid()
    )
  );

CREATE POLICY "spt_own_insert" ON study_plan_tasks
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM study_plans sp
      WHERE sp.id = study_plan_tasks.study_plan_id
        AND sp.student_id = auth.uid()
    )
  );

CREATE POLICY "spt_own_update" ON study_plan_tasks
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM study_plans sp
      WHERE sp.id = study_plan_tasks.study_plan_id
        AND sp.student_id = auth.uid()
    )
  );

CREATE POLICY "spt_own_delete" ON study_plan_tasks
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM study_plans sp
      WHERE sp.id = study_plan_tasks.study_plan_id
        AND sp.student_id = auth.uid()
    )
  );

CREATE POLICY "spt_service_role_all" ON study_plan_tasks
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- 6. FSRS_STATES — student_id scoped (user client in batch-review, spaced-rep)
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE fsrs_states ENABLE ROW LEVEL SECURITY;

CREATE POLICY "fsrs_own_select" ON fsrs_states
  FOR SELECT USING (student_id = auth.uid());

CREATE POLICY "fsrs_own_insert" ON fsrs_states
  FOR INSERT WITH CHECK (student_id = auth.uid());

CREATE POLICY "fsrs_own_update" ON fsrs_states
  FOR UPDATE USING (student_id = auth.uid());

CREATE POLICY "fsrs_own_delete" ON fsrs_states
  FOR DELETE USING (student_id = auth.uid());

CREATE POLICY "fsrs_service_role_all" ON fsrs_states
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- 7. BKT_STATES — student_id scoped (user client in batch-review, spaced-rep)
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE bkt_states ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bkt_own_select" ON bkt_states
  FOR SELECT USING (student_id = auth.uid());

CREATE POLICY "bkt_own_insert" ON bkt_states
  FOR INSERT WITH CHECK (student_id = auth.uid());

CREATE POLICY "bkt_own_update" ON bkt_states
  FOR UPDATE USING (student_id = auth.uid());

CREATE POLICY "bkt_own_delete" ON bkt_states
  FOR DELETE USING (student_id = auth.uid());

CREATE POLICY "bkt_service_role_all" ON bkt_states
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- 8. KW_STUDENT_NOTES — student_id scoped (crud-factory scopeToUser)
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE kw_student_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "kw_sn_own_select" ON kw_student_notes
  FOR SELECT USING (student_id = auth.uid());

CREATE POLICY "kw_sn_own_insert" ON kw_student_notes
  FOR INSERT WITH CHECK (student_id = auth.uid());

CREATE POLICY "kw_sn_own_update" ON kw_student_notes
  FOR UPDATE USING (student_id = auth.uid());

CREATE POLICY "kw_sn_own_delete" ON kw_student_notes
  FOR DELETE USING (student_id = auth.uid());

CREATE POLICY "kw_sn_service_role_all" ON kw_student_notes
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- 9. TEXT_ANNOTATIONS — student_id scoped (crud-factory scopeToUser)
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE text_annotations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "txt_ann_own_select" ON text_annotations
  FOR SELECT USING (student_id = auth.uid());

CREATE POLICY "txt_ann_own_insert" ON text_annotations
  FOR INSERT WITH CHECK (student_id = auth.uid());

CREATE POLICY "txt_ann_own_update" ON text_annotations
  FOR UPDATE USING (student_id = auth.uid());

CREATE POLICY "txt_ann_own_delete" ON text_annotations
  FOR DELETE USING (student_id = auth.uid());

CREATE POLICY "txt_ann_service_role_all" ON text_annotations
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- 10. VIDEO_NOTES — student_id scoped (crud-factory scopeToUser)
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE video_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "vid_notes_own_select" ON video_notes
  FOR SELECT USING (student_id = auth.uid());

CREATE POLICY "vid_notes_own_insert" ON video_notes
  FOR INSERT WITH CHECK (student_id = auth.uid());

CREATE POLICY "vid_notes_own_update" ON video_notes
  FOR UPDATE USING (student_id = auth.uid());

CREATE POLICY "vid_notes_own_delete" ON video_notes
  FOR DELETE USING (student_id = auth.uid());

CREATE POLICY "vid_notes_service_role_all" ON video_notes
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- 11. MODEL_3D_NOTES — student_id scoped (crud-factory scopeToUser)
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE model_3d_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "model_notes_own_select" ON model_3d_notes
  FOR SELECT USING (student_id = auth.uid());

CREATE POLICY "model_notes_own_insert" ON model_3d_notes
  FOR INSERT WITH CHECK (student_id = auth.uid());

CREATE POLICY "model_notes_own_update" ON model_3d_notes
  FOR UPDATE USING (student_id = auth.uid());

CREATE POLICY "model_notes_own_delete" ON model_3d_notes
  FOR DELETE USING (student_id = auth.uid());

CREATE POLICY "model_notes_service_role_all" ON model_3d_notes
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- 12. DAILY_ACTIVITIES — student_id scoped (user client reads in progress.ts)
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE daily_activities ENABLE ROW LEVEL SECURITY;

CREATE POLICY "daily_act_own_select" ON daily_activities
  FOR SELECT USING (student_id = auth.uid());

CREATE POLICY "daily_act_own_insert" ON daily_activities
  FOR INSERT WITH CHECK (student_id = auth.uid());

CREATE POLICY "daily_act_own_update" ON daily_activities
  FOR UPDATE USING (student_id = auth.uid());

CREATE POLICY "daily_act_own_delete" ON daily_activities
  FOR DELETE USING (student_id = auth.uid());

CREATE POLICY "daily_act_service_role_all" ON daily_activities
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- GAMIFICATION TABLES
-- Writes go through getAdminClient() (service_role).
-- Reads often use user client (db) in badges.ts, goals.ts, streak.ts.
-- ══════════════════════════════════════════════════════════════════════════════

-- ══════════════════════════════════════════════════════════════════════════════
-- 13. STUDENT_XP — student_id scoped (reads via db, writes via adminDb)
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE student_xp ENABLE ROW LEVEL SECURITY;

CREATE POLICY "student_xp_own_select" ON student_xp
  FOR SELECT USING (student_id = auth.uid());

-- Leaderboard: institution members can see each other's XP
CREATE POLICY "student_xp_institution_select" ON student_xp
  FOR SELECT USING (institution_id = ANY(public.user_institution_ids()));

CREATE POLICY "student_xp_service_role_all" ON student_xp
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- 14. XP_TRANSACTIONS — student_id scoped (INSERT-ONLY via adminDb)
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE xp_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "xp_tx_own_select" ON xp_transactions
  FOR SELECT USING (student_id = auth.uid());

CREATE POLICY "xp_tx_service_role_all" ON xp_transactions
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- 15. BADGE_DEFINITIONS — global read (all authenticated users), admin write
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE badge_definitions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "badge_def_authenticated_select" ON badge_definitions
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "badge_def_service_role_all" ON badge_definitions
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- 16. BADGE_AWARDS — student_id scoped (writes via adminDb only)
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE student_badges ENABLE ROW LEVEL SECURITY;

CREATE POLICY "student_badges_own_select" ON student_badges
  FOR SELECT USING (student_id = auth.uid());

CREATE POLICY "student_badges_service_role_all" ON student_badges
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- Verification
-- ══════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_tables TEXT[] := ARRAY[
    'reviews', 'quiz_attempts', 'study_sessions', 'study_plans',
    'study_plan_tasks', 'fsrs_states', 'bkt_states',
    'kw_student_notes', 'text_annotations', 'video_notes',
    'model_3d_notes', 'daily_activities',
    'student_xp', 'xp_transactions', 'badge_definitions', 'student_badges'
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

    IF v_rls IS NULL THEN
      RAISE WARNING '[SKIP] % — table does not exist (may be in base schema)', v_table;
    ELSIF v_rls THEN
      RAISE NOTICE '[OK] % — RLS enabled, % policies', v_table, v_policy_count;
    ELSE
      RAISE WARNING '[FAIL] % — RLS NOT enabled!', v_table;
    END IF;
  END LOOP;
END; $$;

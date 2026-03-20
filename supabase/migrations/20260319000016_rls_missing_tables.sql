-- ============================================================================
-- Migration: RLS policies for tables missed in 04/05/06
-- Part of D3 RLS rollout (S11) — discovered in final audit
-- Date: 2026-03-19
--
-- Tables:
--   reading_states  — student-scoped (getUserClient)
--   student_stats   — student-scoped reads (getUserClient) + service writes
--   admin_scopes    — institution-scoped via memberships (getUserClient)
--   streak_freezes  — service_role only (getAdminClient)
--   streak_repairs  — service_role only (getAdminClient)
-- ============================================================================


-- ══════════════════════════════════════════════════════════════════════════════
-- 1. READING_STATES — student-scoped
-- Used by: routes/study/progress.ts (GET + UPSERT), routes/mux/helpers.ts
-- Access: getUserClient (db) — filters by student_id
-- Columns: student_id (uuid), summary_id (uuid)
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE reading_states ENABLE ROW LEVEL SECURITY;

CREATE POLICY "reading_states_own_select" ON reading_states
  FOR SELECT USING (student_id = auth.uid());

CREATE POLICY "reading_states_own_insert" ON reading_states
  FOR INSERT WITH CHECK (student_id = auth.uid());

CREATE POLICY "reading_states_own_update" ON reading_states
  FOR UPDATE USING (student_id = auth.uid());

CREATE POLICY "reading_states_own_delete" ON reading_states
  FOR DELETE USING (student_id = auth.uid());

CREATE POLICY "reading_states_service_role_all" ON reading_states
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- 2. STUDENT_STATS — student reads own, service_role writes
-- Used by: routes/study/progress.ts (GET/UPSERT via db)
--          routes/gamification/profile.ts (GET via db)
--          routes/gamification/goals.ts, streak-engine.ts, xp-hooks.ts (via adminDb)
-- Columns: student_id (uuid)
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE student_stats ENABLE ROW LEVEL SECURITY;

CREATE POLICY "student_stats_own_select" ON student_stats
  FOR SELECT USING (student_id = auth.uid());

-- progress.ts POST /student-stats uses db (user client) for upsert
CREATE POLICY "student_stats_own_insert" ON student_stats
  FOR INSERT WITH CHECK (student_id = auth.uid());

CREATE POLICY "student_stats_own_update" ON student_stats
  FOR UPDATE USING (student_id = auth.uid());

CREATE POLICY "student_stats_service_role_all" ON student_stats
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- 3. ADMIN_SCOPES — institution-scoped via membership FK
-- Used by: routes/members/admin-scopes.ts (GET/POST/DELETE via db)
-- Columns: membership_id (uuid) -> memberships.id
-- All 3 endpoints verify ["owner"] role in requireInstitutionRole()
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE admin_scopes ENABLE ROW LEVEL SECURITY;

-- Owner can read scopes for memberships in their institution
CREATE POLICY "admin_scopes_institution_select" ON admin_scopes
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.id = admin_scopes.membership_id
        AND m.institution_id = ANY(public.user_institution_ids())
    )
  );

CREATE POLICY "admin_scopes_institution_insert" ON admin_scopes
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.id = admin_scopes.membership_id
        AND m.institution_id = ANY(public.user_institution_ids())
    )
  );

-- admin-scopes.ts uses hard DELETE (not soft-delete)
CREATE POLICY "admin_scopes_institution_delete" ON admin_scopes
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.id = admin_scopes.membership_id
        AND m.institution_id = ANY(public.user_institution_ids())
    )
  );

CREATE POLICY "admin_scopes_service_role_all" ON admin_scopes
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- 4. STREAK_FREEZES — service_role only
-- Used by: routes/gamification/streak.ts (via getAdminClient)
--          lib/streak-engine.ts (via getAdminClient)
-- Columns: student_id, institution_id
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE streak_freezes ENABLE ROW LEVEL SECURITY;

-- Students can read their own freezes (streak UI shows freeze inventory)
CREATE POLICY "streak_freezes_own_select" ON streak_freezes
  FOR SELECT USING (student_id = auth.uid());

-- All writes via getAdminClient (service_role)
CREATE POLICY "streak_freezes_service_role_all" ON streak_freezes
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- 5. STREAK_REPAIRS — service_role only
-- Used by: routes/gamification/streak.ts (via getAdminClient)
-- Columns: student_id, institution_id
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE streak_repairs ENABLE ROW LEVEL SECURITY;

-- Students can read their own repairs (streak history)
CREATE POLICY "streak_repairs_own_select" ON streak_repairs
  FOR SELECT USING (student_id = auth.uid());

-- All writes via getAdminClient (service_role)
CREATE POLICY "streak_repairs_service_role_all" ON streak_repairs
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- 6. AI_GENERATIONS — institution-scoped
-- Used by: routes/plans/ai-generations.ts (GET + POST via db)
--          routes/plans/access.ts (GET via db)
-- Columns: institution_id, requested_by
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE ai_generations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ai_gen_institution_select" ON ai_generations
  FOR SELECT USING (institution_id = ANY(public.user_institution_ids()));

CREATE POLICY "ai_gen_institution_insert" ON ai_generations
  FOR INSERT WITH CHECK (
    requested_by = auth.uid()
    AND institution_id = ANY(public.user_institution_ids())
  );

CREATE POLICY "ai_gen_service_role_all" ON ai_generations
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- 7. SUMMARY_DIAGNOSTICS — institution-scoped via summary FK
-- Used by: routes/plans/diagnostics.ts (GET + POST via db)
-- Columns: summary_id (FK -> summaries), requested_by
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE summary_diagnostics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "diag_institution_select" ON summary_diagnostics
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = summary_diagnostics.summary_id
        AND s.institution_id = ANY(public.user_institution_ids())
    )
  );

CREATE POLICY "diag_institution_insert" ON summary_diagnostics
  FOR INSERT WITH CHECK (
    requested_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM summaries s
      WHERE s.id = summary_diagnostics.summary_id
        AND s.institution_id = ANY(public.user_institution_ids())
    )
  );

CREATE POLICY "diag_service_role_all" ON summary_diagnostics
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- 8. PROFILES — service_role only
-- Used by: routes/telegram/handler.ts, routes/whatsapp/handler.ts (via adminDb)
-- Note: Supabase Auth manages profiles. No user-client access from our backend.
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Users can read their own profile
CREATE POLICY "profiles_own_select" ON profiles
  FOR SELECT USING (id = auth.uid());

-- Users can update their own profile
CREATE POLICY "profiles_own_update" ON profiles
  FOR UPDATE USING (id = auth.uid());

-- All other access via service_role (Telegram/WhatsApp handlers)
CREATE POLICY "profiles_service_role_all" ON profiles
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- Verification
-- ══════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_tables TEXT[] := ARRAY[
    'reading_states', 'student_stats', 'admin_scopes',
    'streak_freezes', 'streak_repairs',
    'ai_generations', 'summary_diagnostics', 'profiles'
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
      RAISE WARNING '[SKIP] % — table does not exist', v_table;
    ELSIF v_rls THEN
      RAISE NOTICE '[OK] % — RLS enabled, % policies', v_table, v_policy_count;
    ELSE
      RAISE WARNING '[FAIL] % — RLS NOT enabled!', v_table;
    END IF;
  END LOOP;
END; $$;

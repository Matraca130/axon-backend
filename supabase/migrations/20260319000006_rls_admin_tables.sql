-- ============================================================================
-- Migration: RLS policies for admin-only, messaging, and core tables
-- Part of D3 RLS rollout (S11)
-- Date: 2026-03-19
--
-- Admin/service-only tables (accessed via getAdminClient, no JWT context):
--   telegram_sessions, telegram_message_log,
--   whatsapp_sessions, whatsapp_message_log, whatsapp_jobs,
--   processed_webhook_events, ai_content_reports
--
-- Core tables with special policies:
--   institutions — members can read, service_role writes
--   memberships  — users can read own + institution-scoped, service_role writes
--   kw_prof_notes — institution-scoped content (uses db/user client)
--
-- Plan tables (CRUD via factory with user client):
--   platform_plans, institution_plans,
--   plan_access_rules, institution_subscriptions
--
-- Tables SKIPPED (already have RLS with policies):
--   whatsapp_links (20260314_01), telegram_links (20260316_01),
--   messaging_admin_settings (20260316_01),
--   ai_reading_config (20260303_01), algorithm_config (20260304_01),
--   rag_query_log (20260305_04), summary_blocks (20260228_02),
--   video_views (20260224_02)
-- ============================================================================


-- ══════════════════════════════════════════════════════════════════════════════
-- ADMIN/SERVICE-ONLY TABLES
-- These tables are only accessed via getAdminClient() (service_role).
-- RLS enabled but only service_role has access.
-- ══════════════════════════════════════════════════════════════════════════════

-- 1-4. TELEGRAM + WHATSAPP TABLES (may not exist in all environments)
DO $$
DECLARE
  v_tables TEXT[][] := ARRAY[
    ARRAY['telegram_sessions', 'tg_sessions_service_role_only'],
    ARRAY['telegram_message_log', 'tg_log_service_role_only'],
    ARRAY['whatsapp_sessions', 'wa_sessions_service_role_only'],
    ARRAY['whatsapp_message_log', 'wa_log_service_role_only']
  ];
  v_entry TEXT[];
BEGIN
  FOREACH v_entry SLICE 1 IN ARRAY v_tables LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = v_entry[1]) THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', v_entry[1]);
      EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (auth.role() = ''service_role'')', v_entry[2], v_entry[1]);
      RAISE NOTICE '[OK] % — RLS enabled', v_entry[1];
    ELSE
      RAISE NOTICE '[SKIP] % — table does not exist', v_entry[1];
    END IF;
  END LOOP;
END; $$;


-- 5. WHATSAPP_JOBS (fallback table; may be pgmq-managed instead)
-- Only create RLS if the table exists as a regular table
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'whatsapp_jobs'
  ) THEN
    EXECUTE 'ALTER TABLE whatsapp_jobs ENABLE ROW LEVEL SECURITY';
    EXECUTE 'CREATE POLICY "wa_jobs_service_role_only" ON whatsapp_jobs FOR ALL USING (auth.role() = ''service_role'')';
    RAISE NOTICE '[OK] whatsapp_jobs — RLS enabled';
  ELSE
    RAISE NOTICE '[SKIP] whatsapp_jobs — table does not exist (using pgmq)';
  END IF;
END; $$;


-- 6. PROCESSED_WEBHOOK_EVENTS (may not exist)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'processed_webhook_events') THEN
    EXECUTE 'ALTER TABLE processed_webhook_events ENABLE ROW LEVEL SECURITY';
    EXECUTE 'CREATE POLICY "pwe_service_role_only" ON processed_webhook_events FOR ALL USING (auth.role() = ''service_role'')';
    RAISE NOTICE '[OK] processed_webhook_events — RLS enabled';
  ELSE
    RAISE NOTICE '[SKIP] processed_webhook_events — table does not exist';
  END IF;
END; $$;


-- 7. AI_CONTENT_REPORTS — institution-scoped, accessed via Edge Functions
-- Note: the ai-report endpoints use authenticate() + requireInstitutionRole(),
-- but writes/reads go through the user client (db). We need both institution
-- member read access AND service_role.
ALTER TABLE ai_content_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ai_reports_own_select" ON ai_content_reports
  FOR SELECT USING (reported_by = auth.uid());

CREATE POLICY "ai_reports_institution_select" ON ai_content_reports
  FOR SELECT USING (institution_id = ANY(public.user_institution_ids()));

CREATE POLICY "ai_reports_own_insert" ON ai_content_reports
  FOR INSERT WITH CHECK (
    reported_by = auth.uid()
    AND institution_id = ANY(public.user_institution_ids())
  );

CREATE POLICY "ai_reports_institution_update" ON ai_content_reports
  FOR UPDATE USING (institution_id = ANY(public.user_institution_ids()));

CREATE POLICY "ai_reports_service_role_all" ON ai_content_reports
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- CORE TABLES: INSTITUTIONS & MEMBERSHIPS
-- ══════════════════════════════════════════════════════════════════════════════

-- 8. INSTITUTIONS — members can read their own institutions
-- POST uses getAdminClient(), GET/PUT/DELETE use db (user client)
ALTER TABLE institutions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "inst_members_select" ON institutions
  FOR SELECT USING (id = ANY(public.user_institution_ids()));

-- PUT uses db (user client) in institutions.ts
CREATE POLICY "inst_members_update" ON institutions
  FOR UPDATE USING (id = ANY(public.user_institution_ids()));

CREATE POLICY "inst_service_role_all" ON institutions
  FOR ALL USING (auth.role() = 'service_role');


-- 9. MEMBERSHIPS — users can read own + institution members can list
-- GET /memberships uses db (user client). POST uses adminDb.
-- requireInstitutionRole() itself reads memberships via db, so the
-- policy must allow reading own membership AND institution-scoped reads.
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;

-- Users can always see their own memberships (needed for GET /institutions)
CREATE POLICY "memberships_own_select" ON memberships
  FOR SELECT USING (user_id = auth.uid());

-- Institution admins can see all memberships in their institution
-- (needed for GET /memberships?institution_id=xxx)
CREATE POLICY "memberships_institution_select" ON memberships
  FOR SELECT USING (institution_id = ANY(public.user_institution_ids()));

-- PUT /memberships/:id uses db (user client) — admin/owner can update members
-- in their own institution. requireInstitutionRole() already enforces hierarchy.
CREATE POLICY "memberships_institution_update" ON memberships
  FOR UPDATE USING (institution_id = ANY(public.user_institution_ids()));

-- DELETE /memberships/:id is a soft-delete (UPDATE is_active=false) via db.
-- Same scoping as UPDATE.
CREATE POLICY "memberships_institution_delete" ON memberships
  FOR DELETE USING (institution_id = ANY(public.user_institution_ids()));

-- POST uses getAdminClient() (service_role)
CREATE POLICY "memberships_service_role_all" ON memberships
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- CONTENT: KW_PROF_NOTES
-- Uses db (user client) for all CRUD in prof-notes.ts
-- ══════════════════════════════════════════════════════════════════════════════

-- 10. KW_PROF_NOTES — FK: keyword_id -> keywords -> summaries
ALTER TABLE kw_prof_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "prof_notes_members_select" ON kw_prof_notes
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM keywords k
      JOIN summaries s ON s.id = k.summary_id
      WHERE k.id = kw_prof_notes.keyword_id
        AND s.institution_id = ANY(public.user_institution_ids())
    )
  );

CREATE POLICY "prof_notes_members_insert" ON kw_prof_notes
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM keywords k
      JOIN summaries s ON s.id = k.summary_id
      WHERE k.id = kw_prof_notes.keyword_id
        AND s.institution_id = ANY(public.user_institution_ids())
    )
  );

CREATE POLICY "prof_notes_members_update" ON kw_prof_notes
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM keywords k
      JOIN summaries s ON s.id = k.summary_id
      WHERE k.id = kw_prof_notes.keyword_id
        AND s.institution_id = ANY(public.user_institution_ids())
    )
  );

CREATE POLICY "prof_notes_members_delete" ON kw_prof_notes
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM keywords k
      JOIN summaries s ON s.id = k.summary_id
      WHERE k.id = kw_prof_notes.keyword_id
        AND s.institution_id = ANY(public.user_institution_ids())
    )
  );

CREATE POLICY "prof_notes_service_role_all" ON kw_prof_notes
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- PLAN TABLES (CRUD via factory with user client)
-- ══════════════════════════════════════════════════════════════════════════════

-- 11. PLATFORM_PLANS — global table (no institution_id)
-- Read: all authenticated users (students browse plans)
-- Write: authenticated users (backend enforces owner-only via requireInstitutionRole)
-- Note: This is a global table — RLS cannot enforce institution scoping.
-- The backend's role check is the primary access control for writes.
ALTER TABLE platform_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "platform_plans_authenticated_select" ON platform_plans
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "platform_plans_authenticated_insert" ON platform_plans
  FOR INSERT WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "platform_plans_authenticated_update" ON platform_plans
  FOR UPDATE USING (auth.role() = 'authenticated');

CREATE POLICY "platform_plans_authenticated_delete" ON platform_plans
  FOR DELETE USING (auth.role() = 'authenticated');

CREATE POLICY "platform_plans_service_role_all" ON platform_plans
  FOR ALL USING (auth.role() = 'service_role');


-- 12. INSTITUTION_PLANS — institution-scoped
ALTER TABLE institution_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "inst_plans_members_select" ON institution_plans
  FOR SELECT USING (institution_id = ANY(public.user_institution_ids()));

CREATE POLICY "inst_plans_members_insert" ON institution_plans
  FOR INSERT WITH CHECK (institution_id = ANY(public.user_institution_ids()));

CREATE POLICY "inst_plans_members_update" ON institution_plans
  FOR UPDATE USING (institution_id = ANY(public.user_institution_ids()));

CREATE POLICY "inst_plans_members_delete" ON institution_plans
  FOR DELETE USING (institution_id = ANY(public.user_institution_ids()));

CREATE POLICY "inst_plans_service_role_all" ON institution_plans
  FOR ALL USING (auth.role() = 'service_role');


-- 13. PLAN_ACCESS_RULES — FK: plan_id -> institution_plans
ALTER TABLE plan_access_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "plan_rules_members_select" ON plan_access_rules
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM institution_plans ip
      WHERE ip.id = plan_access_rules.plan_id
        AND ip.institution_id = ANY(public.user_institution_ids())
    )
  );

CREATE POLICY "plan_rules_members_insert" ON plan_access_rules
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM institution_plans ip
      WHERE ip.id = plan_access_rules.plan_id
        AND ip.institution_id = ANY(public.user_institution_ids())
    )
  );

CREATE POLICY "plan_rules_members_update" ON plan_access_rules
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM institution_plans ip
      WHERE ip.id = plan_access_rules.plan_id
        AND ip.institution_id = ANY(public.user_institution_ids())
    )
  );

CREATE POLICY "plan_rules_members_delete" ON plan_access_rules
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM institution_plans ip
      WHERE ip.id = plan_access_rules.plan_id
        AND ip.institution_id = ANY(public.user_institution_ids())
    )
  );

CREATE POLICY "plan_rules_service_role_all" ON plan_access_rules
  FOR ALL USING (auth.role() = 'service_role');


-- 14. INSTITUTION_SUBSCRIPTIONS — institution-scoped
ALTER TABLE institution_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "inst_subs_members_select" ON institution_subscriptions
  FOR SELECT USING (institution_id = ANY(public.user_institution_ids()));

CREATE POLICY "inst_subs_members_insert" ON institution_subscriptions
  FOR INSERT WITH CHECK (institution_id = ANY(public.user_institution_ids()));

CREATE POLICY "inst_subs_members_update" ON institution_subscriptions
  FOR UPDATE USING (institution_id = ANY(public.user_institution_ids()));

CREATE POLICY "inst_subs_members_delete" ON institution_subscriptions
  FOR DELETE USING (institution_id = ANY(public.user_institution_ids()));

CREATE POLICY "inst_subs_service_role_all" ON institution_subscriptions
  FOR ALL USING (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════════════════════
-- Verification
-- ══════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_tables TEXT[] := ARRAY[
    'telegram_sessions', 'telegram_message_log',
    'whatsapp_sessions', 'whatsapp_message_log',
    'processed_webhook_events', 'ai_content_reports',
    'institutions', 'memberships', 'kw_prof_notes',
    'platform_plans', 'institution_plans',
    'plan_access_rules', 'institution_subscriptions'
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

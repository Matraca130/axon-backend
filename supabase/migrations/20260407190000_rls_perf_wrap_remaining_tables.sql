-- =====================================================================
-- RLS Performance: wrap user_institution_ids() with (SELECT ...)::uuid[]
-- Capa 1.5: tablas fuera del scope original de ADR-002
-- Tablas: admin_scopes, ai_content_reports, ai_generations,
--         institution_plans, institution_subscriptions, institutions,
--         kw_prof_notes, memberships, plan_access_rules, student_xp,
--         summary_diagnostics
-- Idempotente: DROP IF EXISTS + CREATE
-- [migration:destructive-ok]
-- =====================================================================

-- ----------------------- admin_scopes -----------------------
DROP POLICY IF EXISTS admin_scopes_institution_select ON public.admin_scopes;
CREATE POLICY admin_scopes_institution_select ON public.admin_scopes
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.memberships m
    WHERE m.id = admin_scopes.membership_id
      AND m.institution_id = ANY ((SELECT public.user_institution_ids())::uuid[])));

DROP POLICY IF EXISTS admin_scopes_institution_insert ON public.admin_scopes;
CREATE POLICY admin_scopes_institution_insert ON public.admin_scopes
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.memberships m
    WHERE m.id = admin_scopes.membership_id
      AND m.institution_id = ANY ((SELECT public.user_institution_ids())::uuid[])));

DROP POLICY IF EXISTS admin_scopes_institution_delete ON public.admin_scopes;
CREATE POLICY admin_scopes_institution_delete ON public.admin_scopes
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.memberships m
    WHERE m.id = admin_scopes.membership_id
      AND m.institution_id = ANY ((SELECT public.user_institution_ids())::uuid[])));

-- ----------------------- ai_content_reports -----------------------
DROP POLICY IF EXISTS ai_reports_institution_select ON public.ai_content_reports;
CREATE POLICY ai_reports_institution_select ON public.ai_content_reports
  FOR SELECT TO authenticated
  USING (institution_id = ANY ((SELECT public.user_institution_ids())::uuid[]));

DROP POLICY IF EXISTS ai_reports_institution_update ON public.ai_content_reports;
CREATE POLICY ai_reports_institution_update ON public.ai_content_reports
  FOR UPDATE TO authenticated
  USING (institution_id = ANY ((SELECT public.user_institution_ids())::uuid[]));

DROP POLICY IF EXISTS ai_reports_own_insert ON public.ai_content_reports;
CREATE POLICY ai_reports_own_insert ON public.ai_content_reports
  FOR INSERT TO authenticated
  WITH CHECK (reported_by = auth.uid()
    AND institution_id = ANY ((SELECT public.user_institution_ids())::uuid[]));

-- ----------------------- ai_generations -----------------------
DROP POLICY IF EXISTS ai_gen_institution_select ON public.ai_generations;
CREATE POLICY ai_gen_institution_select ON public.ai_generations
  FOR SELECT TO authenticated
  USING (institution_id = ANY ((SELECT public.user_institution_ids())::uuid[]));

DROP POLICY IF EXISTS ai_gen_institution_insert ON public.ai_generations;
CREATE POLICY ai_gen_institution_insert ON public.ai_generations
  FOR INSERT TO authenticated
  WITH CHECK (requested_by = auth.uid()
    AND institution_id = ANY ((SELECT public.user_institution_ids())::uuid[]));

-- ----------------------- institution_plans -----------------------
DROP POLICY IF EXISTS inst_plans_members_select ON public.institution_plans;
CREATE POLICY inst_plans_members_select ON public.institution_plans
  FOR SELECT TO authenticated
  USING (institution_id = ANY ((SELECT public.user_institution_ids())::uuid[]));

DROP POLICY IF EXISTS inst_plans_members_insert ON public.institution_plans;
CREATE POLICY inst_plans_members_insert ON public.institution_plans
  FOR INSERT TO authenticated
  WITH CHECK (institution_id = ANY ((SELECT public.user_institution_ids())::uuid[]));

DROP POLICY IF EXISTS inst_plans_members_update ON public.institution_plans;
CREATE POLICY inst_plans_members_update ON public.institution_plans
  FOR UPDATE TO authenticated
  USING (institution_id = ANY ((SELECT public.user_institution_ids())::uuid[]));

DROP POLICY IF EXISTS inst_plans_members_delete ON public.institution_plans;
CREATE POLICY inst_plans_members_delete ON public.institution_plans
  FOR DELETE TO authenticated
  USING (institution_id = ANY ((SELECT public.user_institution_ids())::uuid[]));

-- ----------------------- institution_subscriptions -----------------------
DROP POLICY IF EXISTS inst_subs_members_select ON public.institution_subscriptions;
CREATE POLICY inst_subs_members_select ON public.institution_subscriptions
  FOR SELECT TO authenticated
  USING (institution_id = ANY ((SELECT public.user_institution_ids())::uuid[]));

DROP POLICY IF EXISTS inst_subs_members_insert ON public.institution_subscriptions;
CREATE POLICY inst_subs_members_insert ON public.institution_subscriptions
  FOR INSERT TO authenticated
  WITH CHECK (institution_id = ANY ((SELECT public.user_institution_ids())::uuid[]));

DROP POLICY IF EXISTS inst_subs_members_update ON public.institution_subscriptions;
CREATE POLICY inst_subs_members_update ON public.institution_subscriptions
  FOR UPDATE TO authenticated
  USING (institution_id = ANY ((SELECT public.user_institution_ids())::uuid[]));

DROP POLICY IF EXISTS inst_subs_members_delete ON public.institution_subscriptions;
CREATE POLICY inst_subs_members_delete ON public.institution_subscriptions
  FOR DELETE TO authenticated
  USING (institution_id = ANY ((SELECT public.user_institution_ids())::uuid[]));

-- ----------------------- institutions -----------------------
DROP POLICY IF EXISTS inst_members_select ON public.institutions;
CREATE POLICY inst_members_select ON public.institutions
  FOR SELECT TO authenticated
  USING (id = ANY ((SELECT public.user_institution_ids())::uuid[]));

DROP POLICY IF EXISTS inst_members_update ON public.institutions;
CREATE POLICY inst_members_update ON public.institutions
  FOR UPDATE TO authenticated
  USING (id = ANY ((SELECT public.user_institution_ids())::uuid[]));

-- ----------------------- kw_prof_notes -----------------------
DROP POLICY IF EXISTS prof_notes_members_select ON public.kw_prof_notes;
CREATE POLICY prof_notes_members_select ON public.kw_prof_notes
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.keywords k
    JOIN public.summaries s ON s.id = k.summary_id
    WHERE k.id = kw_prof_notes.keyword_id
      AND s.institution_id = ANY ((SELECT public.user_institution_ids())::uuid[])));

DROP POLICY IF EXISTS prof_notes_members_insert ON public.kw_prof_notes;
CREATE POLICY prof_notes_members_insert ON public.kw_prof_notes
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.keywords k
    JOIN public.summaries s ON s.id = k.summary_id
    WHERE k.id = kw_prof_notes.keyword_id
      AND s.institution_id = ANY ((SELECT public.user_institution_ids())::uuid[])));

DROP POLICY IF EXISTS prof_notes_members_update ON public.kw_prof_notes;
CREATE POLICY prof_notes_members_update ON public.kw_prof_notes
  FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.keywords k
    JOIN public.summaries s ON s.id = k.summary_id
    WHERE k.id = kw_prof_notes.keyword_id
      AND s.institution_id = ANY ((SELECT public.user_institution_ids())::uuid[])));

DROP POLICY IF EXISTS prof_notes_members_delete ON public.kw_prof_notes;
CREATE POLICY prof_notes_members_delete ON public.kw_prof_notes
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.keywords k
    JOIN public.summaries s ON s.id = k.summary_id
    WHERE k.id = kw_prof_notes.keyword_id
      AND s.institution_id = ANY ((SELECT public.user_institution_ids())::uuid[])));

-- ----------------------- memberships -----------------------
DROP POLICY IF EXISTS memberships_institution_select ON public.memberships;
CREATE POLICY memberships_institution_select ON public.memberships
  FOR SELECT TO authenticated
  USING (institution_id = ANY ((SELECT public.user_institution_ids())::uuid[]));

DROP POLICY IF EXISTS memberships_institution_update ON public.memberships;
CREATE POLICY memberships_institution_update ON public.memberships
  FOR UPDATE TO authenticated
  USING (institution_id = ANY ((SELECT public.user_institution_ids())::uuid[]));

DROP POLICY IF EXISTS memberships_institution_delete ON public.memberships;
CREATE POLICY memberships_institution_delete ON public.memberships
  FOR DELETE TO authenticated
  USING (institution_id = ANY ((SELECT public.user_institution_ids())::uuid[]));

-- ----------------------- plan_access_rules -----------------------
DROP POLICY IF EXISTS plan_rules_members_select ON public.plan_access_rules;
CREATE POLICY plan_rules_members_select ON public.plan_access_rules
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.institution_plans ip
    WHERE ip.id = plan_access_rules.plan_id
      AND ip.institution_id = ANY ((SELECT public.user_institution_ids())::uuid[])));

DROP POLICY IF EXISTS plan_rules_members_insert ON public.plan_access_rules;
CREATE POLICY plan_rules_members_insert ON public.plan_access_rules
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.institution_plans ip
    WHERE ip.id = plan_access_rules.plan_id
      AND ip.institution_id = ANY ((SELECT public.user_institution_ids())::uuid[])));

DROP POLICY IF EXISTS plan_rules_members_update ON public.plan_access_rules;
CREATE POLICY plan_rules_members_update ON public.plan_access_rules
  FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.institution_plans ip
    WHERE ip.id = plan_access_rules.plan_id
      AND ip.institution_id = ANY ((SELECT public.user_institution_ids())::uuid[])));

DROP POLICY IF EXISTS plan_rules_members_delete ON public.plan_access_rules;
CREATE POLICY plan_rules_members_delete ON public.plan_access_rules
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.institution_plans ip
    WHERE ip.id = plan_access_rules.plan_id
      AND ip.institution_id = ANY ((SELECT public.user_institution_ids())::uuid[])));

-- ----------------------- student_xp -----------------------
DROP POLICY IF EXISTS student_xp_institution_select ON public.student_xp;
CREATE POLICY student_xp_institution_select ON public.student_xp
  FOR SELECT TO authenticated
  USING (institution_id = ANY ((SELECT public.user_institution_ids())::uuid[]));

-- ----------------------- summary_diagnostics -----------------------
DROP POLICY IF EXISTS diag_institution_select ON public.summary_diagnostics;
CREATE POLICY diag_institution_select ON public.summary_diagnostics
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.summaries s
    WHERE s.id = summary_diagnostics.summary_id
      AND s.institution_id = ANY ((SELECT public.user_institution_ids())::uuid[])));

DROP POLICY IF EXISTS diag_institution_insert ON public.summary_diagnostics;
CREATE POLICY diag_institution_insert ON public.summary_diagnostics
  FOR INSERT TO authenticated
  WITH CHECK (requested_by = auth.uid()
    AND EXISTS (SELECT 1 FROM public.summaries s
      WHERE s.id = summary_diagnostics.summary_id
        AND s.institution_id = ANY ((SELECT public.user_institution_ids())::uuid[])));

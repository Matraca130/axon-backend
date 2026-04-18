-- ============================================================================
-- Migration: Re-apply SECURITY DEFINER RPC revokes with overload-qualified
-- function signatures
-- Date: 2026-04-17
--
-- Problem:
--   The original 20260405000001_security_revoke_anon_all_definer_rpcs uses
--   `REVOKE ... ON FUNCTION <name> FROM ...` without an argument list. If any
--   of the 22 functions ever gains an overload (same name, different
--   signature), the unqualified syntax raises `function name is not unique`
--   and the migration aborts. Any new overload also escapes the policy
--   silently because the unqualified statement matched only the single
--   pre-existing variant when first applied.
--
-- Fix:
--   For each (name, target_role) pair, look up every overload in pg_proc
--   under the public schema and emit a fully qualified
--   `REVOKE ... ON FUNCTION public.foo(uuid, text)` and a matching GRANT.
--   This is safe regardless of whether overloads exist now or are added
--   later (re-running the migration covers them).
--
-- Out of scope (intentionally NOT touched):
--   - rate_limit_entries cleanup RPC and any other public RPC explicitly
--     designed to be anon-callable. None of the 22 names below qualify;
--     this list mirrors the original migration scope.
--
-- Idempotency:
--   REVOKE + GRANT are idempotent. Loops over zero rows when a function
--   does not exist (e.g., if it was renamed/removed in a later migration).
-- ============================================================================

BEGIN;

DO $$
DECLARE
  spec record;
  proc_sig text;
BEGIN
  FOR spec IN
    SELECT * FROM (
      VALUES
        -- GROUP 1: SERVICE_ROLE ONLY (internal/admin/AI/RAG/cron/triggers)
        ('award_xp',                       'service_role'),
        ('get_ai_report_stats',            'service_role'),
        ('get_course_summary_ids',         'service_role'),
        ('get_institution_summary_ids',    'service_role'),
        ('get_student_knowledge_context',  'service_role'),
        ('rag_analytics_summary',          'service_role'),
        ('rag_embedding_coverage',         'service_role'),
        ('resolve_student_summary_ids',    'service_role'),
        ('resolve_parent_institution',     'service_role'),
        ('upsert_video_view',              'service_role'),
        ('trash_scoped',                   'service_role'),
        ('compute_cohort_difficulty',      'service_role'),
        ('increment_daily_stat',           'service_role'),
        ('refresh_leaderboard_weekly',     'service_role'),
        ('reset_correct_streak',           'service_role'),
        ('on_review_inserted',             'service_role'),
        ('on_study_session_completed',     'service_role'),

        -- GROUP 2: AUTHENTICATED (user-facing RPCs)
        ('create_text_annotation',         'authenticated'),
        ('find_similar_topics',            'authenticated'),
        ('advisory_unlock',                'authenticated'),
        ('try_advisory_lock',              'authenticated'),
        ('user_institution_ids',           'authenticated')
    ) AS t(func_name, target_role)
  LOOP
    FOR proc_sig IN
      SELECT (p.oid::regprocedure)::text
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = spec.func_name
    LOOP
      EXECUTE format(
        'REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated',
        proc_sig
      );
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION %s TO %I',
        proc_sig, spec.target_role
      );
      RAISE NOTICE '[OK] Re-applied REVOKE + GRANT(%) on %', spec.target_role, proc_sig;
    END LOOP;
  END LOOP;
END; $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION — assert each named function exists at least once and has
-- no anon EXECUTE grant remaining.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_func_name text;
  v_total int := 0;
  v_with_anon int := 0;
BEGIN
  FOR v_func_name IN
    SELECT unnest(ARRAY[
      'award_xp','get_ai_report_stats','get_course_summary_ids',
      'get_institution_summary_ids','get_student_knowledge_context',
      'rag_analytics_summary','rag_embedding_coverage',
      'resolve_student_summary_ids','resolve_parent_institution',
      'upsert_video_view','trash_scoped','compute_cohort_difficulty',
      'increment_daily_stat','refresh_leaderboard_weekly',
      'reset_correct_streak','on_review_inserted','on_study_session_completed',
      'create_text_annotation','find_similar_topics','advisory_unlock',
      'try_advisory_lock','user_institution_ids'
    ])
  LOOP
    SELECT count(*) INTO v_total
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_func_name;

    IF v_total = 0 THEN
      RAISE WARNING '[MISSING] public.% has no overloads — was it renamed?', v_func_name;
      CONTINUE;
    END IF;

    SELECT count(*) INTO v_with_anon
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) ax ON true
      JOIN pg_roles r ON r.oid = ax.grantee
     WHERE n.nspname = 'public'
       AND p.proname = v_func_name
       AND r.rolname = 'anon'
       AND ax.privilege_type = 'EXECUTE';

    IF v_with_anon > 0 THEN
      RAISE WARNING '[UNEXPECTED] public.% — % overload(s) still grant EXECUTE to anon',
        v_func_name, v_with_anon;
    END IF;
  END LOOP;
END; $$;

COMMIT;

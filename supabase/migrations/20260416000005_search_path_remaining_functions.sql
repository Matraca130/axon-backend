-- ============================================================================
-- Migration: Pin search_path on the 18 remaining public functions
-- Date: 2026-04-16
-- Advisor lint: function_search_path_mutable (WARN, 18 remaining after PR #239)
--
-- Problem:
--   Per the Supabase linter, 22 functions in schema `public` have a role-
--   mutable search_path. PR #239 (security/search-path-hardening-2026-04-16)
--   pinned the 4 SECURITY DEFINER functions (award_xp, check_block_sync_health,
--   get_course_summary_ids, rag_block_search). The 18 remaining here are
--   SECURITY INVOKER (prosecdef=false confirmed in pg_proc on 2026-04-16) —
--   the hijack threat is narrower (no privilege elevation), but a role that
--   can create objects in any schema earlier on the default search_path
--   can still shadow unqualified references inside these bodies and alter
--   trigger/RPC behaviour for the calling user. Pinning the path closes
--   that vector and brings the project to zero `function_search_path_mutable`
--   warnings.
--
-- Fix:
--   ALTER FUNCTION public.<name>(<signature>) SET search_path = public, pg_temp.
--   No body change, so idempotent and cannot regress behaviour.
--
-- Signatures verified against pg_proc on 2026-04-16. All 18 functions exist
-- with exactly one overload.
--
-- Rollback:
--   ALTER FUNCTION public.<name>(<signature>) RESET search_path;
-- ============================================================================

-- ── Trigger helpers (no-arg) ────────────────────────────────────────────────
ALTER FUNCTION public.set_updated_at()                               SET search_path = public, pg_temp;
ALTER FUNCTION public.update_updated_at()                            SET search_path = public, pg_temp;
ALTER FUNCTION public.update_ai_content_reports_updated_at()         SET search_path = public, pg_temp;
ALTER FUNCTION public.update_messaging_admin_settings_updated_at()   SET search_path = public, pg_temp;
ALTER FUNCTION public.update_summary_blocks_updated_at()             SET search_path = public, pg_temp;
ALTER FUNCTION public.update_telegram_sessions_updated_at()          SET search_path = public, pg_temp;
ALTER FUNCTION public.update_video_views_updated_at()                SET search_path = public, pg_temp;
ALTER FUNCTION public.update_whatsapp_sessions_updated_at()          SET search_path = public, pg_temp;
ALTER FUNCTION public.sync_summary_institution_id()                  SET search_path = public, pg_temp;

-- ── Scheduled jobs / invariants (no-arg) ────────────────────────────────────
ALTER FUNCTION public.cleanup_expired_rate_limits()                  SET search_path = public, pg_temp;
ALTER FUNCTION public.refresh_leaderboard()                          SET search_path = public, pg_temp;
ALTER FUNCTION public.reset_daily_xp()                               SET search_path = public, pg_temp;
ALTER FUNCTION public.reset_weekly_xp()                              SET search_path = public, pg_temp;
ALTER FUNCTION public.generate_invite_code()                         SET search_path = public, pg_temp;

-- ── Parametrised RPCs ───────────────────────────────────────────────────────
ALTER FUNCTION public.check_rate_limit(text, integer, integer)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.get_content_tree(uuid)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.get_smart_generate_target(uuid, uuid, uuid, integer)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.get_study_queue(uuid, uuid, integer, boolean)
  SET search_path = public, pg_temp;


-- ═══════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ═══════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_func text;
  v_setting text;
  v_expected text := 'search_path=public, pg_temp';
  v_missing int := 0;
BEGIN
  FOR v_func IN
    SELECT unnest(ARRAY[
      'set_updated_at','update_updated_at','update_ai_content_reports_updated_at',
      'update_messaging_admin_settings_updated_at','update_summary_blocks_updated_at',
      'update_telegram_sessions_updated_at','update_video_views_updated_at',
      'update_whatsapp_sessions_updated_at','sync_summary_institution_id',
      'cleanup_expired_rate_limits','refresh_leaderboard','reset_daily_xp',
      'reset_weekly_xp','generate_invite_code','check_rate_limit',
      'get_content_tree','get_smart_generate_target','get_study_queue'
    ])
  LOOP
    SELECT (SELECT string_agg(c, ',')
              FROM unnest(p.proconfig) c
             WHERE c LIKE 'search_path=%')
      INTO v_setting
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_func
     LIMIT 1;

    IF v_setting IS NULL OR v_setting NOT LIKE 'search_path=public%' THEN
      RAISE WARNING '[MISSING] public.% has no pinned search_path (got %)', v_func, v_setting;
      v_missing := v_missing + 1;
    END IF;
  END LOOP;

  IF v_missing = 0 THEN
    RAISE NOTICE '[OK] All 18 remaining public functions have search_path pinned';
  ELSE
    RAISE WARNING '[FAIL] % of 18 functions still missing search_path', v_missing;
  END IF;
END; $$;

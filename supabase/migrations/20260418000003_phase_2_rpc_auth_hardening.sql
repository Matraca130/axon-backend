-- ============================================================================
-- Migration: Phase 2 — RPC auth hardening
-- Date: 2026-04-18
-- Plan: docs/security/2026-04-17-remediation-plan.md Phase 2.5
-- Audit references: iter 15 #3 (MEDIUM) + iter 20 #1 (CRITICAL, escalated)
--                   + iter 20 #2 (HIGH) + rls-auditor Phase-1 scope-gap #1
-- ============================================================================
-- Two SECURITY DEFINER RPCs were trusting caller-supplied student_id without
-- cross-checking against auth.uid(). Either:
--   (a) The RPC was already created + granted to authenticated → every
--       authenticated user could poison any other student's learning state.
--   (b) The RPC was declared in the repo but never applied to live DB →
--       the Edge Function route /batch-review has been returning 500 in
--       production since the declaration landed (observed 2026-04-18:
--       live pg_proc has no process_review_batch).
--
-- This migration fixes BOTH: creates the hardened version of
-- process_review_batch on live (was missing), and CREATE OR REPLACEs
-- increment_block_mastery_attempts with the same auth.uid() guard pattern.
--
-- After this migration, both RPCs:
--   - Keep SECURITY DEFINER + GRANT to authenticated (needed by routes
--     that use user-client `db.rpc(...)`).
--   - Raise EXCEPTION if caller-supplied student_id != auth.uid().
-- ============================================================================

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 1: Harden + create process_review_batch
-- ═══════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.process_review_batch(uuid, jsonb, jsonb, jsonb);

CREATE OR REPLACE FUNCTION public.process_review_batch(
  p_session_id uuid,
  p_reviews jsonb,
  p_fsrs jsonb,
  p_bkt jsonb
)
RETURNS TABLE(
  reviews_created int,
  fsrs_updated int,
  bkt_updated int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_session_owner uuid;
  v_reviews_created int := 0;
  v_fsrs_updated int := 0;
  v_bkt_updated int := 0;
  v_bad_elem jsonb;
BEGIN
  -- ─── 0. Authorization: caller must own the session ──────────────
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT s.student_id INTO v_session_owner
    FROM public.study_sessions s
   WHERE s.id = p_session_id;
  IF v_session_owner IS NULL THEN
    RAISE EXCEPTION 'session % not found', p_session_id;
  END IF;
  IF v_session_owner <> v_caller THEN
    RAISE EXCEPTION 'session % is owned by another student', p_session_id;
  END IF;

  -- ─── 0b. Every FSRS/BKT element must target the caller's student_id ──
  SELECT elem INTO v_bad_elem
    FROM jsonb_array_elements(COALESCE(p_fsrs, '[]'::jsonb)) AS elem
   WHERE (elem->>'student_id')::uuid IS DISTINCT FROM v_caller
   LIMIT 1;
  IF v_bad_elem IS NOT NULL THEN
    RAISE EXCEPTION 'fsrs element targets another student_id: %', v_bad_elem->>'student_id';
  END IF;

  SELECT elem INTO v_bad_elem
    FROM jsonb_array_elements(COALESCE(p_bkt, '[]'::jsonb)) AS elem
   WHERE (elem->>'student_id')::uuid IS DISTINCT FROM v_caller
   LIMIT 1;
  IF v_bad_elem IS NOT NULL THEN
    RAISE EXCEPTION 'bkt element targets another student_id: %', v_bad_elem->>'student_id';
  END IF;

  -- ─── 1. Bulk insert reviews ─────────────────────────────────────
  IF jsonb_array_length(COALESCE(p_reviews, '[]'::jsonb)) > 0 THEN
    WITH inserted AS (
      INSERT INTO reviews (session_id, item_id, instrument_type, grade, response_time_ms)
      SELECT
        p_session_id,
        (elem->>'item_id')::uuid,
        elem->>'instrument_type',
        (elem->>'grade')::int,
        NULLIF(elem->>'response_time_ms', '')::int
      FROM jsonb_array_elements(p_reviews) AS elem
      RETURNING 1
    )
    SELECT count(*) INTO v_reviews_created FROM inserted;
  END IF;

  -- ─── 2. Bulk upsert fsrs_states ─────────────────────────────────
  IF jsonb_array_length(COALESCE(p_fsrs, '[]'::jsonb)) > 0 THEN
    WITH upserted AS (
      INSERT INTO fsrs_states (student_id, flashcard_id, stability, difficulty, due_at, last_review_at, reps, lapses, state, consecutive_lapses, is_leech)
      SELECT
        (elem->>'student_id')::uuid,
        (elem->>'flashcard_id')::uuid,
        (elem->>'stability')::numeric,
        (elem->>'difficulty')::numeric,
        (elem->>'due_at')::timestamptz,
        (elem->>'last_review_at')::timestamptz,
        (elem->>'reps')::int,
        (elem->>'lapses')::int,
        elem->>'state',
        (elem->>'consecutive_lapses')::int,
        (elem->>'is_leech')::boolean
      FROM jsonb_array_elements(p_fsrs) AS elem
      ON CONFLICT (student_id, flashcard_id) DO UPDATE SET
        stability          = EXCLUDED.stability,
        difficulty         = EXCLUDED.difficulty,
        due_at             = EXCLUDED.due_at,
        last_review_at     = EXCLUDED.last_review_at,
        reps               = EXCLUDED.reps,
        lapses             = EXCLUDED.lapses,
        state              = EXCLUDED.state,
        consecutive_lapses = EXCLUDED.consecutive_lapses,
        is_leech           = EXCLUDED.is_leech
      RETURNING 1
    )
    SELECT count(*) INTO v_fsrs_updated FROM upserted;
  END IF;

  -- ─── 3. Bulk upsert bkt_states with atomic counter increments ────
  IF jsonb_array_length(COALESCE(p_bkt, '[]'::jsonb)) > 0 THEN
    WITH upserted AS (
      INSERT INTO bkt_states (student_id, subtopic_id, p_know, max_p_know, p_transit, p_slip, p_guess, delta, total_attempts, correct_attempts, last_attempt_at)
      SELECT
        (elem->>'student_id')::uuid,
        (elem->>'subtopic_id')::uuid,
        (elem->>'p_know')::numeric,
        (elem->>'max_p_know')::numeric,
        (elem->>'p_transit')::numeric,
        (elem->>'p_slip')::numeric,
        (elem->>'p_guess')::numeric,
        (elem->>'delta')::numeric,
        (elem->>'total_delta')::int,
        (elem->>'correct_delta')::int,
        (elem->>'last_attempt_at')::timestamptz
      FROM jsonb_array_elements(p_bkt) AS elem
      ON CONFLICT (student_id, subtopic_id) DO UPDATE SET
        p_know           = EXCLUDED.p_know,
        max_p_know       = EXCLUDED.max_p_know,
        p_transit        = EXCLUDED.p_transit,
        p_slip           = EXCLUDED.p_slip,
        p_guess          = EXCLUDED.p_guess,
        delta            = EXCLUDED.delta,
        total_attempts   = COALESCE(bkt_states.total_attempts, 0)   + EXCLUDED.total_attempts,
        correct_attempts = COALESCE(bkt_states.correct_attempts, 0) + EXCLUDED.correct_attempts,
        last_attempt_at  = EXCLUDED.last_attempt_at
      RETURNING 1
    )
    SELECT count(*) INTO v_bkt_updated FROM upserted;
  END IF;

  RETURN QUERY SELECT v_reviews_created, v_fsrs_updated, v_bkt_updated;
END;
$$;

REVOKE ALL ON FUNCTION public.process_review_batch(uuid, jsonb, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.process_review_batch(uuid, jsonb, jsonb, jsonb) TO authenticated;

COMMENT ON FUNCTION public.process_review_batch(uuid, jsonb, jsonb, jsonb) IS
'Atomic batch persistence for POST /review-batch. Hardened per Phase 2 security audit: verifies caller == session owner, and every fsrs/bkt element student_id == auth.uid(). Raises EXCEPTION on mismatch.';


-- ═══════════════════════════════════════════════════════════════════════════
-- PART 2: Harden increment_block_mastery_attempts
-- ═══════════════════════════════════════════════════════════════════════════
-- The function was recreated via dashboard with proconfig pg_temp (see live
-- pg_proc.proconfig). Body does NOT check auth.uid() — iter 20 #2. Phase 1
-- kept the authenticated grant because routes/study/block-review.ts:158
-- calls it with user JWT. Now add the guard.

CREATE OR REPLACE FUNCTION public.increment_block_mastery_attempts(
  p_student_id uuid,
  p_block_id uuid,
  p_total_delta integer DEFAULT 1,
  p_correct_delta integer DEFAULT 0
)
RETURNS TABLE(new_total_attempts integer, new_correct_attempts integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller uuid := auth.uid();
BEGIN
  -- Hardened: caller must be the student being incremented.
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_student_id <> v_caller THEN
    RAISE EXCEPTION 'cannot increment another student''s block mastery';
  END IF;

  RETURN QUERY
  UPDATE block_mastery_states
     SET total_attempts   = COALESCE(total_attempts, 0) + p_total_delta,
         correct_attempts = COALESCE(correct_attempts, 0) + p_correct_delta,
         updated_at       = now()
   WHERE student_id = p_student_id
     AND block_id = p_block_id
  RETURNING total_attempts, correct_attempts;
END;
$$;

-- Grants survive CREATE OR REPLACE but re-apply defensively
REVOKE ALL ON FUNCTION public.increment_block_mastery_attempts(uuid, uuid, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.increment_block_mastery_attempts(uuid, uuid, integer, integer) TO authenticated;

COMMENT ON FUNCTION public.increment_block_mastery_attempts(uuid, uuid, integer, integer) IS
'Atomic counter increment for block mastery. Hardened per Phase 2 audit: caller must equal p_student_id (auth.uid() check). Raises EXCEPTION on mismatch.';


-- ═══════════════════════════════════════════════════════════════════════════
-- PART 3: Verification
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  -- process_review_batch exists and is SECURITY DEFINER + pg_temp
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname='public' AND p.proname='process_review_batch'
      AND p.prosecdef = true
      AND EXISTS (SELECT 1 FROM unnest(p.proconfig) x WHERE x ILIKE '%pg_temp%')
  ) THEN
    RAISE EXCEPTION 'process_review_batch not properly created';
  END IF;

  -- increment_block_mastery_attempts still has pg_temp + SECURITY DEFINER
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname='public' AND p.proname='increment_block_mastery_attempts'
      AND p.prosecdef = true
      AND EXISTS (SELECT 1 FROM unnest(p.proconfig) x WHERE x ILIKE '%pg_temp%')
  ) THEN
    RAISE EXCEPTION 'increment_block_mastery_attempts lost pg_temp / SECURITY DEFINER';
  END IF;

  -- Both functions: anon=false, authenticated=true
  IF has_function_privilege('anon', 'public.process_review_batch(uuid, jsonb, jsonb, jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.increment_block_mastery_attempts(uuid, uuid, integer, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon has EXECUTE on one of the RPCs';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.process_review_batch(uuid, jsonb, jsonb, jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.increment_block_mastery_attempts(uuid, uuid, integer, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated missing EXECUTE (needed by user-JWT callers)';
  END IF;

  RAISE NOTICE '[OK] Phase 2 RPC auth hardening applied and verified';
END $$;

COMMIT;

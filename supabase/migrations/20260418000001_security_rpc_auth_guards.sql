-- Migration: Security fix — auth.uid() guards on SECURITY DEFINER RPCs
-- Date: 2026-04-18
--
-- Fixes:
--   C-01: process_review_batch accepted arbitrary student_id in p_fsrs/p_bkt
--         payloads, allowing any authenticated user to corrupt another user's
--         FSRS learning state and BKT mastery via direct PostgREST RPC call.
--
--   C-02: increment_block_mastery_attempts accepted arbitrary p_student_id,
--         allowing any authenticated user to manipulate another user's block
--         mastery counters via direct PostgREST RPC call.
--
-- Both functions are SECURITY DEFINER (bypass RLS) + GRANT TO authenticated.
-- The backend TS code always passes the correct user.id, but PostgREST
-- exposes these RPCs directly to any authenticated caller.

-- ═══════════════════════════════════════════════════════════════
-- C-01 FIX: process_review_batch
-- ═══════════════════════════════════════════════════════════════

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
  v_reviews_created int := 0;
  v_fsrs_updated int := 0;
  v_bkt_updated int := 0;
  v_caller_id uuid;
BEGIN
  -- ─── AUTH GUARD: verify caller identity ─────────────────────
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'unauthorized: no authenticated user';
  END IF;

  -- ─── AUTH GUARD: verify session ownership ───────────────────
  IF NOT EXISTS (
    SELECT 1 FROM study_sessions
    WHERE id = p_session_id AND student_id = v_caller_id
  ) THEN
    RAISE EXCEPTION 'unauthorized: session does not belong to caller';
  END IF;

  -- ─── AUTH GUARD: verify all student_ids in p_fsrs match caller
  IF jsonb_array_length(COALESCE(p_fsrs, '[]'::jsonb)) > 0 THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_fsrs) AS elem
      WHERE (elem->>'student_id')::uuid IS DISTINCT FROM v_caller_id
    ) THEN
      RAISE EXCEPTION 'unauthorized: p_fsrs contains student_id not matching caller';
    END IF;
  END IF;

  -- ─── AUTH GUARD: verify all student_ids in p_bkt match caller
  IF jsonb_array_length(COALESCE(p_bkt, '[]'::jsonb)) > 0 THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_bkt) AS elem
      WHERE (elem->>'student_id')::uuid IS DISTINCT FROM v_caller_id
    ) THEN
      RAISE EXCEPTION 'unauthorized: p_bkt contains student_id not matching caller';
    END IF;
  END IF;

  -- ─── 1. Bulk insert reviews ─────────────────────────────────
  IF jsonb_array_length(COALESCE(p_reviews, '[]'::jsonb)) > 0 THEN
    WITH inserted AS (
      INSERT INTO reviews (
        session_id,
        item_id,
        instrument_type,
        grade,
        response_time_ms
      )
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

  -- ─── 2. Bulk upsert fsrs_states ─────────────────────────────
  IF jsonb_array_length(COALESCE(p_fsrs, '[]'::jsonb)) > 0 THEN
    WITH upserted AS (
      INSERT INTO fsrs_states (
        student_id,
        flashcard_id,
        stability,
        difficulty,
        due_at,
        last_review_at,
        reps,
        lapses,
        state,
        consecutive_lapses,
        is_leech
      )
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

  -- ─── 3. Bulk upsert bkt_states (with atomic counter increments)
  IF jsonb_array_length(COALESCE(p_bkt, '[]'::jsonb)) > 0 THEN
    WITH upserted AS (
      INSERT INTO bkt_states (
        student_id,
        subtopic_id,
        p_know,
        max_p_know,
        p_transit,
        p_slip,
        p_guess,
        delta,
        total_attempts,
        correct_attempts,
        last_attempt_at
      )
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

REVOKE ALL ON FUNCTION public.process_review_batch(uuid, jsonb, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.process_review_batch(uuid, jsonb, jsonb, jsonb) TO authenticated;

COMMENT ON FUNCTION public.process_review_batch(uuid, jsonb, jsonb, jsonb) IS
'Atomic batch persistence for POST /review-batch. Validates auth.uid() ownership of session and all student_ids before writing. Inserts reviews + upserts fsrs_states + upserts bkt_states in a single transaction.';


-- ═══════════════════════════════════════════════════════════════
-- C-02 FIX: increment_block_mastery_attempts
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION increment_block_mastery_attempts(
  p_student_id UUID,
  p_block_id UUID,
  p_total_delta INT DEFAULT 1,
  p_correct_delta INT DEFAULT 0
)
RETURNS TABLE(new_total_attempts INT, new_correct_attempts INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- ─── AUTH GUARD: caller can only modify own data ────────────
  IF p_student_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'unauthorized: cannot modify other student data';
  END IF;

  RETURN QUERY
  UPDATE block_mastery_states
  SET
    total_attempts   = COALESCE(total_attempts, 0) + p_total_delta,
    correct_attempts = COALESCE(correct_attempts, 0) + p_correct_delta,
    updated_at       = now()
  WHERE student_id = p_student_id
    AND block_id = p_block_id
  RETURNING total_attempts, correct_attempts;
END;
$$;

GRANT EXECUTE ON FUNCTION increment_block_mastery_attempts TO authenticated;


-- ═══════════════════════════════════════════════════════════════
-- H-04 FIX: get_heavy_studiers_today
-- ═══════════════════════════════════════════════════════════════
-- This function returns cross-student study data (student_id,
-- institution_id, total_seconds) for ALL students who studied 4+
-- hours. It is designed exclusively for the pg_cron job
-- "check-maraton-badge" (runs as superuser). No Edge Function or
-- TS code calls it. REVOKE from authenticated to prevent any
-- logged-in user from enumerating other students' study behavior.

REVOKE ALL ON FUNCTION get_heavy_studiers_today(DATE, INTEGER) FROM authenticated;
REVOKE ALL ON FUNCTION get_heavy_studiers_today(DATE, INTEGER) FROM PUBLIC;


-- ═══════════════════════════════════════════════════════════════
-- M-01 FIX: resolve_student_summary_ids
-- ═══════════════════════════════════════════════════════════════
-- SECURITY DEFINER RPC that returns summary IDs accessible to a
-- student. Previously accepted any p_student_id without verifying
-- the caller owns that identity. Called from resolvers.ts with
-- the authenticated user's ID.

CREATE OR REPLACE FUNCTION resolve_student_summary_ids(
  p_student_id      UUID,
  p_institution_id  UUID
)
RETURNS TABLE(summary_id UUID)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT s.id
  FROM summaries s
  WHERE
    -- AUTH GUARD: caller can only query own accessible summaries
    p_student_id = auth.uid()
    AND s.institution_id = p_institution_id
    AND s.deleted_at IS NULL
    AND s.is_active = true
    AND s.status = 'published'
    AND EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.user_id = p_student_id
        AND m.institution_id = p_institution_id
        AND m.is_active = true
    );
$$;

REVOKE ALL ON FUNCTION resolve_student_summary_ids(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_student_summary_ids(UUID, UUID) TO authenticated;

COMMENT ON FUNCTION resolve_student_summary_ids IS
  'Returns published summary IDs accessible to the calling student within an institution. Validates auth.uid() ownership.';

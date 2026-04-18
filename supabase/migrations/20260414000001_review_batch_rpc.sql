-- Migration: Transactional review batch RPC
-- Date: 2026-04-14
--
-- Purpose: Atomic persistence for `POST /review-batch`.
--
-- Problem: The previous TS-side loop in batch-review.ts issued independent
--          inserts/upserts per review. If the FSRS upsert or the BKT counter
--          RPC failed after the review row was already inserted, the
--          resulting state was partially consistent (review written but no
--          FSRS/BKT update, or vice-versa).
--
-- Solution: One `process_review_batch(p_session_id, p_reviews, p_fsrs, p_bkt)`
--           RPC that runs every write in a single transaction. PL/pgSQL
--           functions implicitly run inside a single txn; any error rolls
--           the whole batch back.
--
-- Computation (FSRS v4 Petrick + BKT v4 Recovery + leech detection) stays in
-- TypeScript. This RPC only performs the pre-computed DB writes.
--
-- NOTE: The existing `on_review_inserted` trigger (migration
-- 20260228000001_dashboard_aggregation_triggers.sql) still fires per row
-- inside this transaction, keeping daily_activities and student_stats in
-- sync automatically. That's N trigger invocations per batch — a future
-- optimization could move the aggregation into this RPC explicitly, but
-- leaving the trigger-based path preserves existing invariants.

-- ─── Drop prior definition if it exists ────────────────────────────
DROP FUNCTION IF EXISTS public.process_review_batch(uuid, jsonb, jsonb, jsonb);

CREATE OR REPLACE FUNCTION public.process_review_batch(
  p_session_id uuid,
  p_reviews jsonb,  -- [{item_id, instrument_type, grade, response_time_ms?}]
  p_fsrs jsonb,     -- [{student_id, flashcard_id, stability, difficulty,
                    --    due_at, last_review_at, reps, lapses, state,
                    --    consecutive_lapses, is_leech}]
  p_bkt jsonb       -- [{student_id, subtopic_id, p_know, max_p_know,
                    --    p_transit, p_slip, p_guess, delta,
                    --    total_delta, correct_delta, last_attempt_at}]
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
BEGIN
  -- ─── 1. Bulk insert reviews ─────────────────────────────────────
  -- The `on_review_inserted` trigger fires per row here, keeping
  -- daily_activities / student_stats consistent automatically.
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

  -- ─── 2. Bulk upsert fsrs_states ─────────────────────────────────
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

  -- ─── 3. Bulk upsert bkt_states (with atomic counter increments) ─
  -- Counter arithmetic is inlined into the ON CONFLICT clause so we do
  -- not need a second RPC call (`increment_bkt_attempts`). When an
  -- existing row is found, total_attempts and correct_attempts are
  -- incremented by the deltas shipped in the jsonb payload.
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
        -- Seed counters for brand-new rows using the deltas provided.
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
        -- Atomic arithmetic increment — the deltas ride along in EXCLUDED.
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

-- ─── Grants ────────────────────────────────────────────────────
-- The RPC is invoked from Edge Functions via the authenticated
-- Supabase client. `authenticated` is the role the client runs under.
REVOKE ALL ON FUNCTION public.process_review_batch(uuid, jsonb, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.process_review_batch(uuid, jsonb, jsonb, jsonb) TO authenticated;

COMMENT ON FUNCTION public.process_review_batch(uuid, jsonb, jsonb, jsonb) IS
'Atomic batch persistence for POST /review-batch. Inserts reviews + upserts fsrs_states + upserts bkt_states (with inline counter arithmetic) in a single transaction. FSRS v4 and BKT v4 computation happens in TypeScript before this RPC is called.';

-- ============================================================================
-- Migration: Atomic Streak Freeze Buy RPC
-- Date: 2026-03-19
-- Purpose: Replace read-then-write pattern in streak.ts freeze buy endpoint
--          with a single atomic SQL function. Prevents race conditions where
--          concurrent requests could double-spend XP or exceed MAX_FREEZES.
--
-- Called by: streak.ts → db.rpc("buy_streak_freeze", { ... })
-- Replaces: Multi-step SELECT→UPDATE→INSERT chain in streak-freeze/buy route
--
-- Safety:
--   - SECURITY DEFINER with search_path = public, pg_temp
--   - FOR UPDATE lock on student_xp row prevents concurrent double-spend
--   - All-or-nothing: function runs in a single transaction
--   - REVOKE from public/anon, GRANT to authenticated + service_role
-- ============================================================================

CREATE OR REPLACE FUNCTION buy_streak_freeze(
  p_student_id     UUID,
  p_institution_id UUID,
  p_cost           INT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_max_freezes   CONSTANT INT := 3;
  v_current_xp    INT;
  v_freezes_owned INT;
  v_active_count  INT;
  v_freeze_id     UUID;
BEGIN
  -- 1. Check active (unused) freeze count
  SELECT COUNT(*)
    INTO v_active_count
    FROM streak_freezes
   WHERE student_id = p_student_id
     AND institution_id = p_institution_id
     AND used_on IS NULL;

  IF v_active_count >= v_max_freezes THEN
    RETURN jsonb_build_object(
      'error', 'max_freezes_reached',
      'max_freezes', v_max_freezes,
      'current_freezes', v_active_count
    );
  END IF;

  -- 2. Lock and read student_xp row
  SELECT total_xp, streak_freezes_owned
    INTO v_current_xp, v_freezes_owned
    FROM student_xp
   WHERE student_id = p_student_id
     AND institution_id = p_institution_id
   FOR UPDATE;

  -- If no row exists, student has 0 XP
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'error', 'insufficient_xp',
      'required', p_cost,
      'balance', 0
    );
  END IF;

  -- 3. Check balance
  IF v_current_xp < p_cost THEN
    RETURN jsonb_build_object(
      'error', 'insufficient_xp',
      'required', p_cost,
      'balance', v_current_xp
    );
  END IF;

  -- 4. Deduct XP and increment freezes_owned
  UPDATE student_xp
     SET total_xp = total_xp - p_cost,
         streak_freezes_owned = COALESCE(streak_freezes_owned, 0) + 1,
         updated_at = now()
   WHERE student_id = p_student_id
     AND institution_id = p_institution_id;

  -- 5. Insert streak freeze record (G-001: includes freeze_type + xp_cost)
  INSERT INTO streak_freezes (
    student_id, institution_id, freeze_type, xp_cost
  ) VALUES (
    p_student_id, p_institution_id, 'purchased', p_cost
  )
  RETURNING id INTO v_freeze_id;

  -- 6. Insert XP transaction log (immutable, INSERT-ONLY)
  INSERT INTO xp_transactions (
    student_id, institution_id, action,
    xp_base, xp_final, multiplier,
    source_type, source_id
  ) VALUES (
    p_student_id, p_institution_id, 'streak_freeze_buy',
    -p_cost, -p_cost, 1,
    'streak_freeze', v_freeze_id::TEXT
  );

  -- 7. Return success with updated state
  RETURN jsonb_build_object(
    'success',        true,
    'freeze_id',      v_freeze_id,
    'xp_spent',       p_cost,
    'remaining_xp',   v_current_xp - p_cost,
    'freezes_owned',  v_active_count + 1
  );
END;
$$;

COMMENT ON FUNCTION buy_streak_freeze IS
  'Atomically buys a streak freeze: checks balance, deducts XP, creates freeze, '
  'logs transaction. Prevents race condition double-spend. Called by streak.ts.';

-- ── Security: REVOKE/GRANT ──────────────────────────────────────────────

REVOKE ALL ON FUNCTION buy_streak_freeze(UUID, UUID, INT)
  FROM public, anon;

GRANT EXECUTE ON FUNCTION buy_streak_freeze(UUID, UUID, INT)
  TO authenticated, service_role;

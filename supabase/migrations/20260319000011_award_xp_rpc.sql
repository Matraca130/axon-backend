-- ============================================================================
-- Migration: award_xp SQL RPC
-- Date: 2026-03-19
-- Purpose: Create the award_xp() function called by xp-engine.ts (line ~144).
--          Atomically inserts xp_transaction + upserts student_xp aggregates.
--          Enforces daily cap (500 XP) with 10% post-cap rate (§6.4).
--
-- Called by: xp-engine.ts → db.rpc("award_xp", { p_student_id, ... })
-- Replaces: JS fallback path (awardXPFallback) which has race conditions
--
-- Safety:
--   - SECURITY DEFINER with search_path = public, pg_temp
--   - REVOKE from public/anon, GRANT to authenticated + service_role
--   - All writes are atomic (single function = single transaction)
-- ============================================================================

CREATE OR REPLACE FUNCTION award_xp(
  p_student_id    UUID,
  p_institution_id UUID,
  p_action        TEXT,
  p_xp_base       INT,
  p_multiplier    NUMERIC DEFAULT 1.0,
  p_bonus_type    TEXT DEFAULT NULL,
  p_source_type   TEXT DEFAULT NULL,
  p_source_id     TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_daily_cap     CONSTANT INT := 500;
  v_post_cap_rate CONSTANT NUMERIC := 0.1;
  v_xp_final      INT;
  v_capped_xp     INT;
  v_current       RECORD;
  v_remaining_cap INT;
  v_new_total     INT;
  v_new_today     INT;
  v_new_week      INT;
  v_new_level     INT;
BEGIN
  -- Calculate raw XP
  v_xp_final := ROUND(p_xp_base * p_multiplier);

  -- Get current aggregates (may not exist for new students)
  SELECT total_xp, xp_today, xp_this_week, current_level
    INTO v_current
    FROM student_xp
   WHERE student_id = p_student_id
     AND institution_id = p_institution_id
   FOR UPDATE;  -- Row-level lock for atomicity

  -- Default to 0 if student has no record yet
  IF NOT FOUND THEN
    v_current := ROW(0, 0, 0, 1);
  END IF;

  -- Apply daily cap with 10% post-cap rate (§6.4)
  v_remaining_cap := v_daily_cap - v_current.xp_today;
  IF v_remaining_cap <= 0 THEN
    -- Post-cap: 10% of calculated XP, minimum 1
    v_capped_xp := GREATEST(1, ROUND(v_xp_final * v_post_cap_rate));
  ELSE
    v_capped_xp := LEAST(v_xp_final, v_remaining_cap);
  END IF;

  -- Calculate new totals
  v_new_total := v_current.total_xp + v_capped_xp;
  v_new_today := v_current.xp_today + v_capped_xp;
  v_new_week  := v_current.xp_this_week + v_capped_xp;

  -- Calculate level from thresholds (matches LEVEL_THRESHOLDS in xp-engine.ts)
  v_new_level := CASE
    WHEN v_new_total >= 10000 THEN 12
    WHEN v_new_total >= 7500  THEN 11
    WHEN v_new_total >= 5500  THEN 10
    WHEN v_new_total >= 4000  THEN 9
    WHEN v_new_total >= 3000  THEN 8
    WHEN v_new_total >= 2200  THEN 7
    WHEN v_new_total >= 1500  THEN 6
    WHEN v_new_total >= 1000  THEN 5
    WHEN v_new_total >= 600   THEN 4
    WHEN v_new_total >= 300   THEN 3
    WHEN v_new_total >= 100   THEN 2
    ELSE 1
  END;

  -- 1. Insert immutable transaction log
  INSERT INTO xp_transactions (
    student_id, institution_id, action,
    xp_base, xp_final, multiplier, bonus_type,
    source_type, source_id
  ) VALUES (
    p_student_id, p_institution_id, p_action,
    p_xp_base, v_capped_xp, p_multiplier, p_bonus_type,
    p_source_type, p_source_id
  );

  -- 2. Upsert student_xp aggregates
  INSERT INTO student_xp (
    student_id, institution_id,
    total_xp, xp_today, xp_this_week,
    current_level, updated_at
  ) VALUES (
    p_student_id, p_institution_id,
    v_capped_xp, v_capped_xp, v_capped_xp,
    v_new_level, now()
  )
  ON CONFLICT (student_id, institution_id) DO UPDATE SET
    total_xp      = v_new_total,
    xp_today      = v_new_today,
    xp_this_week  = v_new_week,
    current_level = v_new_level,
    updated_at    = now();

  -- Return result matching AwardResult interface in xp-engine.ts
  RETURN jsonb_build_object(
    'xp_awarded', v_capped_xp,
    'xp_base',    p_xp_base,
    'multiplier', p_multiplier,
    'bonus_type', p_bonus_type,
    'daily_used', v_new_today,
    'daily_cap',  v_daily_cap,
    'total_xp',   v_new_total,
    'level',      v_new_level
  );
END;
$$;

COMMENT ON FUNCTION award_xp IS
  'Atomically awards XP: inserts xp_transaction + upserts student_xp. '
  'Enforces daily cap (500) with 10% post-cap rate. Called by xp-engine.ts.';

-- ── Security: REVOKE/GRANT ──────────────────────────────────────────────
-- Service calls come via service_role (admin client in xp-engine.ts).
-- Authenticated needed for any future direct client RPC calls.

REVOKE ALL ON FUNCTION award_xp(UUID, UUID, TEXT, INT, NUMERIC, TEXT, TEXT, TEXT)
  FROM public, anon;

GRANT EXECUTE ON FUNCTION award_xp(UUID, UUID, TEXT, INT, NUMERIC, TEXT, TEXT, TEXT)
  TO authenticated, service_role;

-- ============================================================================
-- Migration: Maraton de Estudio cron job
-- Date: 2026-04-02
-- Purpose: Daily pg_cron job that awards "Maraton de Estudio" badge to
--          students who studied 4+ hours in a single day during finals.
--
-- Approach: SQL function called by pg_cron. Checks study_sessions for
--           students with 4+ hours today, cross-references finals_periods,
--           and awards the badge via student_badges + XP.
-- ============================================================================

-- RPC: Find students who studied 4+ hours on a given date
CREATE OR REPLACE FUNCTION get_heavy_studiers_today(
  p_date DATE DEFAULT CURRENT_DATE,
  p_min_seconds INTEGER DEFAULT 14400
)
RETURNS TABLE (
  student_id UUID,
  institution_id UUID,
  total_seconds BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    ss.student_id,
    c.institution_id,
    COALESCE(
      SUM(
        EXTRACT(EPOCH FROM (ss.completed_at - ss.created_at))::BIGINT
      ),
      0
    ) AS total_seconds
  FROM study_sessions ss
  JOIN courses c ON c.id = ss.course_id
  WHERE ss.completed_at IS NOT NULL
    AND ss.created_at >= p_date AND ss.created_at < p_date + interval '1 day'
  GROUP BY ss.student_id, c.institution_id
  HAVING COALESCE(
    SUM(EXTRACT(EPOCH FROM (ss.completed_at - ss.created_at))::BIGINT),
    0
  ) >= p_min_seconds
$$;

-- Revoke from PUBLIC (blocks all direct access), keep authenticated for Edge Function usage
REVOKE ALL ON FUNCTION get_heavy_studiers_today(DATE, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_heavy_studiers_today(DATE, INTEGER) TO authenticated;

-- Daily cron: Award Maraton badge at 02:00 UTC (23:00 ART)
SELECT cron.schedule(
  'check-maraton-badge',
  '0 2 * * *',
  $$
  DO $body$
  DECLARE
    r RECORD;
    v_badge_id UUID;
    v_xp_reward INT;
    v_inserted_id UUID;
  BEGIN
    PERFORM set_config('search_path', 'public, pg_temp', true);

    -- Find the badge definition (including xp_reward for XP awarding)
    SELECT id, xp_reward INTO v_badge_id, v_xp_reward
    FROM badge_definitions
    WHERE slug = 'maraton_de_estudio'
      AND is_active = true
    LIMIT 1;

    IF v_badge_id IS NULL THEN
      RETURN;
    END IF;

    -- For each heavy studier today who is in a finals period
    FOR r IN
      SELECT hs.student_id, hs.institution_id
      FROM get_heavy_studiers_today(CURRENT_DATE, 14400) hs
      WHERE EXISTS (
        SELECT 1 FROM finals_periods fp
        WHERE fp.institution_id = hs.institution_id
          AND CURRENT_DATE BETWEEN fp.finals_period_start AND fp.finals_period_end
      )
    LOOP
      -- Award badge (skip if already earned)
      INSERT INTO student_badges (student_id, badge_id, institution_id)
      VALUES (r.student_id, v_badge_id, r.institution_id)
      ON CONFLICT DO NOTHING
      RETURNING id INTO v_inserted_id;

      -- Award XP only if badge was newly inserted (not a duplicate)
      IF v_inserted_id IS NOT NULL AND COALESCE(v_xp_reward, 0) > 0 THEN
        PERFORM award_xp(
          p_student_id     := r.student_id,
          p_institution_id := r.institution_id,
          p_action         := 'badge_maraton_de_estudio',
          p_xp_base        := v_xp_reward,
          p_multiplier     := 1.0,
          p_bonus_type     := NULL,
          p_source_type    := 'badge',
          p_source_id      := v_badge_id::TEXT
        );
      END IF;
    END LOOP;
  END $body$;
  $$
);

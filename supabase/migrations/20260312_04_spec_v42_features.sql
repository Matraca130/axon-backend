-- ============================================================
-- Migration: Spec v4.2 Full Feature Implementation
-- Date: 2026-03-12
-- Purpose: Implement remaining spec features:
--   1. clinical_priority on keywords (§6.4)
--   2. Leech detection on fsrs_states (consecutive_lapses + is_leech)
--   3. 5-color scale with relative Δ mode (§6.2)
--   4. Domination threshold per clinical_priority (§6.3)
--   5. Foundation/prerequisite columns on keywords
--   6. Rescue mode threshold in algorithm_config
--   7. Enriched study-queue return (reps, lapses, etc.)
-- ============================================================

-- ══════════════════════════════════════════════════════════════
-- 1. CLINICAL PRIORITY on keywords
-- ══════════════════════════════════════════════════════════════
-- Spec §6.4: Keywords have a clinical_priority [0,1] that
-- scales NeedScore exponentially.
-- priority=0 (trivia) → ×2.0 multiplier
-- priority=0.5 (important) → ×3.0 multiplier  
-- priority=1.0 (critical/Adrenalina) → ×5.0 multiplier

ALTER TABLE keywords
  ADD COLUMN IF NOT EXISTS clinical_priority NUMERIC NOT NULL DEFAULT 0;

-- Constraint: must be in [0, 1]
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'keywords_clinical_priority_range'
  ) THEN
    ALTER TABLE keywords
      ADD CONSTRAINT keywords_clinical_priority_range
      CHECK (clinical_priority >= 0 AND clinical_priority <= 1);
  END IF;
END
$$;

-- Index for filtering high-priority keywords
CREATE INDEX IF NOT EXISTS idx_keywords_clinical_priority
  ON keywords(clinical_priority DESC)
  WHERE clinical_priority > 0;

-- ══════════════════════════════════════════════════════════════
-- 2. LEECH DETECTION on fsrs_states
-- ══════════════════════════════════════════════════════════════
-- A leech is a card the student keeps failing despite many reviews.
-- consecutive_lapses tracks how many Again grades in a row.
-- is_leech is set when consecutive_lapses >= leech_threshold.

ALTER TABLE fsrs_states
  ADD COLUMN IF NOT EXISTS consecutive_lapses INTEGER NOT NULL DEFAULT 0;

ALTER TABLE fsrs_states
  ADD COLUMN IF NOT EXISTS is_leech BOOLEAN NOT NULL DEFAULT false;

-- Index for leech queries (admin/professor dashboards)
CREATE INDEX IF NOT EXISTS idx_fsrs_states_leeches
  ON fsrs_states(student_id)
  WHERE is_leech = true;

-- ══════════════════════════════════════════════════════════════
-- 3. ALGORITHM CONFIG extensions
-- ══════════════════════════════════════════════════════════════
-- Add leech threshold, domination parameters, and rescue threshold.

ALTER TABLE algorithm_config
  ADD COLUMN IF NOT EXISTS leech_threshold INTEGER NOT NULL DEFAULT 8;

ALTER TABLE algorithm_config
  ADD COLUMN IF NOT EXISTS domination_base NUMERIC NOT NULL DEFAULT 0.70;

ALTER TABLE algorithm_config
  ADD COLUMN IF NOT EXISTS domination_priority_scale NUMERIC NOT NULL DEFAULT 0.20;

ALTER TABLE algorithm_config
  ADD COLUMN IF NOT EXISTS rescue_mastery_floor NUMERIC NOT NULL DEFAULT 0.30;

-- CHECK constraints
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'algorithm_config_leech_positive'
  ) THEN
    ALTER TABLE algorithm_config
      ADD CONSTRAINT algorithm_config_leech_positive
      CHECK (leech_threshold > 0);
  END IF;
END
$$;

-- Update global defaults row with new column values
UPDATE algorithm_config
  SET leech_threshold = 8,
      domination_base = 0.70,
      domination_priority_scale = 0.20,
      rescue_mastery_floor = 0.30
  WHERE institution_id IS NULL;

-- ══════════════════════════════════════════════════════════════
-- 4. FOUNDATION / PREREQUISITE columns on keywords
-- ══════════════════════════════════════════════════════════════
-- Professors can mark keywords as foundations (must be mastered
-- before dependents) and set prerequisite relationships.

ALTER TABLE keywords
  ADD COLUMN IF NOT EXISTS is_foundation BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE keywords
  ADD COLUMN IF NOT EXISTS prerequisite_keyword_ids UUID[] DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_keywords_foundations
  ON keywords(summary_id)
  WHERE is_foundation = true;

-- ══════════════════════════════════════════════════════════════
-- 5. NORMALIZED LEVEL on topics (materialized aggregation)
-- ══════════════════════════════════════════════════════════════
-- Tracks what percentage of a topic's keywords are "mastered".
-- Updated by a trigger or periodic job.

ALTER TABLE topics
  ADD COLUMN IF NOT EXISTS normalized_level NUMERIC NOT NULL DEFAULT 0;

-- ══════════════════════════════════════════════════════════════
-- 6. RECREATE get_study_queue with ALL spec features
-- ══════════════════════════════════════════════════════════════
-- Now includes:
--   - clinical_priority from keywords
--   - NeedScore exponential scaling: baseScore × (1 + 2^(priority×2))
--   - 5-color scale: red/orange/yellow/green/blue with relative Δ
--   - Domination threshold: 0.70 + (priority × 0.20)
--   - Leech flagging
--   - Enriched return: reps, lapses, last_review_at, max_p_know, etc.

DROP FUNCTION IF EXISTS get_study_queue(uuid, uuid, integer, boolean);

CREATE OR REPLACE FUNCTION get_study_queue(
  p_student_id UUID,
  p_course_id UUID DEFAULT NULL,
  p_limit INTEGER DEFAULT 20,
  p_include_future BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
  flashcard_id UUID,
  summary_id UUID,
  keyword_id UUID,
  subtopic_id UUID,
  front TEXT,
  back TEXT,
  front_image_url TEXT,
  back_image_url TEXT,
  need_score NUMERIC,
  retention NUMERIC,
  mastery_color TEXT,
  p_know NUMERIC,
  fsrs_state TEXT,
  due_at TIMESTAMPTZ,
  stability NUMERIC,
  difficulty NUMERIC,
  is_new BOOLEAN,
  total_count BIGINT,
  -- v4.2 enrichment: FSRS state details
  reps INTEGER,
  lapses INTEGER,
  last_review_at TIMESTAMPTZ,
  -- v4.2 enrichment: BKT details
  max_p_know NUMERIC,
  -- v4.2 enrichment: clinical priority
  clinical_priority NUMERIC,
  -- v4.2 enrichment: leech detection
  consecutive_lapses INTEGER,
  is_leech BOOLEAN
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
  -- Dynamic weights from algorithm_config
  v_overdue_w        NUMERIC;
  v_mastery_w        NUMERIC;
  v_fragility_w      NUMERIC;
  v_novelty_w        NUMERIC;
  v_grace_days       NUMERIC;
  -- Domination threshold params
  v_dom_base         NUMERIC;
  v_dom_priority_scale NUMERIC;
  -- Leech threshold
  v_leech_threshold  INTEGER;
BEGIN
  -- ── Load algorithm_config (institution-specific > global > hardcoded) ──
  SELECT
    COALESCE(cfg.overdue_weight,            0.40),
    COALESCE(cfg.mastery_weight,            0.30),
    COALESCE(cfg.fragility_weight,          0.20),
    COALESCE(cfg.novelty_weight,            0.10),
    COALESCE(cfg.grace_days,                1.0),
    COALESCE(cfg.domination_base,           0.70),
    COALESCE(cfg.domination_priority_scale, 0.20),
    COALESCE(cfg.leech_threshold,           8)
  INTO v_overdue_w, v_mastery_w, v_fragility_w, v_novelty_w,
       v_grace_days, v_dom_base, v_dom_priority_scale, v_leech_threshold
  FROM algorithm_config cfg
  WHERE cfg.institution_id IN (
    SELECT m.institution_id FROM memberships m
    WHERE m.user_id = p_student_id AND m.is_active = true
  )
  ORDER BY cfg.institution_id IS NULL ASC
  LIMIT 1;

  -- Ultimate fallback
  IF v_overdue_w IS NULL THEN
    v_overdue_w        := 0.40;
    v_mastery_w        := 0.30;
    v_fragility_w      := 0.20;
    v_novelty_w        := 0.10;
    v_grace_days       := 1.0;
    v_dom_base         := 0.70;
    v_dom_priority_scale := 0.20;
    v_leech_threshold  := 8;
  END IF;

  RETURN QUERY
  WITH
  student_institutions AS (
    SELECT m.institution_id
    FROM memberships m
    WHERE m.user_id = p_student_id AND m.is_active = true
  ),
  student_courses AS (
    SELECT c.id
    FROM courses c
    WHERE c.institution_id IN (SELECT institution_id FROM student_institutions)
      AND c.is_active = true
  ),
  allowed_summaries AS (
    SELECT s.id
    FROM summaries s
    JOIN topics t ON t.id = s.topic_id AND t.deleted_at IS NULL
    JOIN sections sec ON sec.id = t.section_id AND sec.deleted_at IS NULL
    JOIN semesters sem ON sem.id = sec.semester_id AND sem.deleted_at IS NULL
    WHERE s.deleted_at IS NULL
      AND (
        (p_course_id IS NOT NULL AND sem.course_id = p_course_id)
        OR
        (p_course_id IS NULL AND sem.course_id IN (SELECT id FROM student_courses))
      )
  ),

  -- Step 2: Active flashcards + keyword clinical_priority
  active_cards AS (
    SELECT
      f.id, f.summary_id, f.keyword_id, f.subtopic_id,
      f.front, f.back, f.front_image_url, f.back_image_url,
      COALESCE(kw.clinical_priority, 0) AS kw_clinical_priority
    FROM flashcards f
    LEFT JOIN keywords kw ON kw.id = f.keyword_id
    WHERE f.is_active = true AND f.deleted_at IS NULL
      AND f.status = 'published'
      AND f.summary_id IN (SELECT id FROM allowed_summaries)
  ),

  -- Step 3: Join with FSRS states
  cards_with_fsrs AS (
    SELECT
      ac.*,
      fs.stability AS fsrs_stability,
      fs.difficulty AS fsrs_difficulty,
      fs.due_at AS fsrs_due_at,
      fs.last_review_at AS fsrs_last_review_at,
      fs.reps AS fsrs_reps,
      fs.lapses AS fsrs_lapses,
      fs.state AS fsrs_state_val,
      COALESCE(fs.consecutive_lapses, 0) AS fsrs_consecutive_lapses,
      COALESCE(fs.is_leech, false) AS fsrs_is_leech,
      (fs.flashcard_id IS NULL) AS card_is_new,
      CASE
        WHEN fs.last_review_at IS NULL THEN 0
        ELSE GREATEST(0, EXTRACT(EPOCH FROM (v_now - fs.last_review_at)) / 86400.0)
      END AS elapsed_days
    FROM active_cards ac
    LEFT JOIN fsrs_states fs
      ON fs.flashcard_id = ac.id AND fs.student_id = p_student_id
    WHERE p_include_future OR fs.flashcard_id IS NULL OR fs.due_at <= v_now
  ),

  -- Step 4: Join with BKT + compute scores
  cards_with_scores AS (
    SELECT
      c.*,
      COALESCE(bkt.p_know, 0) AS bkt_p_know,
      COALESCE(bkt.max_p_know, 0) AS bkt_max_p_know,

      -- ── FSRS v4 Power-Law Retention ──
      CASE
        WHEN c.fsrs_last_review_at IS NULL OR COALESCE(c.fsrs_stability, 0) <= 0 THEN 0.0
        ELSE GREATEST(0, LEAST(1.0,
          POWER(1.0 + c.elapsed_days / (9.0 * COALESCE(c.fsrs_stability, 1)), -1)
        ))
      END AS computed_retention,

      -- ── NeedScore base (v4.2 weights from algorithm_config) ──
      (
        v_overdue_w * CASE
          WHEN c.fsrs_due_at IS NULL THEN 1.0
          WHEN v_now > c.fsrs_due_at THEN
            1.0 - EXP(-EXTRACT(EPOCH FROM (v_now - c.fsrs_due_at)) / 86400.0 / v_grace_days)
          ELSE 0.0
        END
        + v_mastery_w * (1.0 - COALESCE(bkt.p_know, 0))
        + v_fragility_w * LEAST(1.0,
            COALESCE(c.fsrs_lapses, 0)::NUMERIC
            / GREATEST(1, COALESCE(c.fsrs_reps, 0) + COALESCE(c.fsrs_lapses, 0) + 1)::NUMERIC)
        + v_novelty_w * CASE WHEN COALESCE(c.fsrs_state_val, 'new') = 'new' THEN 1.0 ELSE 0.0 END
      ) AS base_need_score,

      -- ── clinical_priority exponential multiplier (§6.4) ──
      -- finalScore = baseScore × (1 + 2^(priority × 2.0))
      -- priority=0 → ×2.0, priority=0.5 → ×3.0, priority=1.0 → ×5.0
      (1.0 + POWER(2.0, c.kw_clinical_priority * 2.0)) AS priority_multiplier,

      -- ── Domination threshold (§6.3) ──
      -- threshold = domination_base + (priority × domination_priority_scale)
      -- priority=0 → 0.70, priority=0.5 → 0.80, priority=1.0 → 0.90
      (v_dom_base + c.kw_clinical_priority * v_dom_priority_scale) AS domination_threshold

    FROM cards_with_fsrs c
    LEFT JOIN bkt_states bkt
      ON bkt.subtopic_id = c.subtopic_id AND bkt.student_id = p_student_id
  ),

  -- Step 5: Compute final scores + 5-color scale
  final_scores AS (
    SELECT
      cs.*,
      -- Final NeedScore with clinical_priority scaling
      cs.base_need_score * cs.priority_multiplier AS final_need_score,

      -- Display mastery (§7.1): p_know × R
      cs.bkt_p_know * GREATEST(cs.computed_retention, CASE WHEN cs.bkt_p_know > 0 AND cs.fsrs_last_review_at IS NULL THEN 1.0 ELSE cs.computed_retention END) AS display_mastery,

      -- Relative Δ (§6.2): displayMastery / dominationThreshold
      CASE
        WHEN cs.domination_threshold <= 0 THEN 0.0
        ELSE (
          cs.bkt_p_know
          * CASE
              WHEN cs.fsrs_last_review_at IS NULL AND cs.bkt_p_know > 0 THEN 1.0
              WHEN cs.fsrs_last_review_at IS NULL OR COALESCE(cs.fsrs_stability, 0) <= 0 THEN 0.0
              ELSE GREATEST(0, LEAST(1.0, POWER(1.0 + cs.elapsed_days / (9.0 * COALESCE(cs.fsrs_stability, 1)), -1)))
            END
        ) / cs.domination_threshold
      END AS mastery_delta
    FROM cards_with_scores cs
  )

  -- Final SELECT with 5-color scale
  SELECT
    fs.id AS flashcard_id,
    fs.summary_id,
    fs.keyword_id,
    fs.subtopic_id,
    fs.front,
    fs.back,
    fs.front_image_url,
    fs.back_image_url,
    ROUND(fs.final_need_score::NUMERIC, 3) AS need_score,
    ROUND(fs.computed_retention::NUMERIC, 3) AS retention,
    -- 5-Color Scale (§6.2): red/orange/yellow/green/blue
    CASE
      WHEN fs.bkt_p_know <= 0 THEN 'gray'
      WHEN fs.mastery_delta >= 1.10 THEN 'blue'     -- Superado: well above threshold
      WHEN fs.mastery_delta >= 1.00 THEN 'green'    -- Dominado: at or above threshold
      WHEN fs.mastery_delta >= 0.85 THEN 'yellow'   -- Casi: approaching threshold
      WHEN fs.mastery_delta >= 0.50 THEN 'orange'   -- En progreso: making progress
      ELSE 'red'                                     -- Critico: far below threshold
    END AS mastery_color,
    ROUND(fs.bkt_p_know::NUMERIC, 3) AS p_know,
    COALESCE(fs.fsrs_state_val, 'new') AS fsrs_state,
    fs.fsrs_due_at AS due_at,
    COALESCE(fs.fsrs_stability, 1)::NUMERIC AS stability,
    COALESCE(fs.fsrs_difficulty, 5)::NUMERIC AS difficulty,
    fs.card_is_new AS is_new,
    COUNT(*) OVER() AS total_count,
    -- v4.2 enrichment
    COALESCE(fs.fsrs_reps, 0) AS reps,
    COALESCE(fs.fsrs_lapses, 0) AS lapses,
    fs.fsrs_last_review_at AS last_review_at,
    ROUND(fs.bkt_max_p_know::NUMERIC, 3) AS max_p_know,
    ROUND(fs.kw_clinical_priority::NUMERIC, 2) AS clinical_priority,
    fs.fsrs_consecutive_lapses AS consecutive_lapses,
    fs.fsrs_is_leech AS is_leech
  FROM final_scores fs
  ORDER BY
    fs.final_need_score DESC,
    fs.computed_retention ASC,
    fs.card_is_new ASC
  LIMIT p_limit;
END;
$$;

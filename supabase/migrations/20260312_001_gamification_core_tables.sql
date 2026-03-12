-- ============================================================
-- GAMIFICATION SPRINT 0 — STEP 1: CORE TABLES
-- student_xp + xp_transactions
--
-- Contract refs: §5.2 (schema), §5.3 (conventions), §6.1 (multi-tenancy)
-- Pattern: UUID PK, institution_id FK, TIMESTAMPTZ, UNIQUE constraints
-- ============================================================

-- ─── student_xp ────────────────────────────────────────────
-- Per-student XP aggregates, scoped to institution.
-- UNIQUE(student_id, institution_id) mirrors memberships pattern.
-- streak_freezes_owned tracks purchasable items (§3.2 streak economy).
-- daily_goal_minutes is student-configurable (SDT Autonomy).
--
-- ⚠ xp_today and xp_this_week are reset by pg_cron (§3.8).
-- ⚠ total_xp MUST only be modified via award_xp() RPC (§7.9).
-- ⚠ current_level is computed by award_xp() using LEVEL_THRESHOLDS (§10).

CREATE TABLE IF NOT EXISTS student_xp (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id       UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  institution_id   UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  total_xp         INTEGER NOT NULL DEFAULT 0,
  current_level    INTEGER NOT NULL DEFAULT 1,
  xp_today         INTEGER NOT NULL DEFAULT 0,
  xp_this_week     INTEGER NOT NULL DEFAULT 0,
  streak_freezes_owned INTEGER NOT NULL DEFAULT 0,
  daily_goal_minutes   INTEGER NOT NULL DEFAULT 10,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(student_id, institution_id)
);

COMMENT ON TABLE student_xp IS 'Per-student XP aggregates scoped to institution. Modified ONLY via award_xp() RPC.';
COMMENT ON COLUMN student_xp.xp_today IS 'Reset daily at 00:00 UTC by pg_cron. Used for daily cap enforcement (500 XP).';
COMMENT ON COLUMN student_xp.xp_this_week IS 'Reset weekly on Monday 00:00 UTC by pg_cron. Used for weekly leaderboard.';
COMMENT ON COLUMN student_xp.streak_freezes_owned IS 'Max 2 active freezes enforced in application code (§6.3).';
COMMENT ON COLUMN student_xp.daily_goal_minutes IS 'Student-configurable daily study goal (SDT Autonomy). Default 10 min.';


-- ─── xp_transactions ───────────────────────────────────────
-- Immutable log of every XP gain/loss. INSERT-ONLY (§6.8).
-- No updated_at column — rows are never modified after creation.
--
-- action: human-readable key matching XP_TABLE in xp-engine.ts
--   e.g. 'review_correct', 'quiz_correct', 'complete_session',
--        'streak_freeze_purchase' (negative xp_base)
--
-- bonus_type: compound bonus descriptor
--   e.g. 'on_time', 'flow_zone', 'on_time+streak', 'variable+flow_zone'
--   NULL when no bonus applied (multiplier = 1.0)
--
-- source_type + source_id: soft reference to the triggering entity
--   e.g. source_type='flashcard', source_id=<flashcard UUID>
--   Allows XP audit trail without hard FK (items may be deleted)
--
-- ⚠ xp_base is the RAW amount before multiplier.
-- ⚠ xp_final = ROUND(xp_base * multiplier), respecting daily cap.
-- ⚠ multiplier uses ADDITIVE combo rule (§10): on_time(0.5) + streak(0.5) = ×2.0

CREATE TABLE IF NOT EXISTS xp_transactions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id       UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  institution_id   UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  action           TEXT NOT NULL,
  xp_base          INTEGER NOT NULL,
  xp_final         INTEGER NOT NULL,
  multiplier       NUMERIC NOT NULL DEFAULT 1.0,
  bonus_type       TEXT,
  source_type      TEXT,
  source_id        UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE xp_transactions IS 'Immutable XP event log. INSERT-ONLY — never UPDATE or DELETE (§6.8).';
COMMENT ON COLUMN xp_transactions.action IS 'XP_TABLE key from xp-engine.ts: review_correct, quiz_correct, complete_session, etc.';
COMMENT ON COLUMN xp_transactions.xp_base IS 'Raw XP amount before multiplier. Can be negative for purchases (streak freeze).';
COMMENT ON COLUMN xp_transactions.xp_final IS 'Final XP after multiplier and daily cap. ROUND(xp_base * multiplier).';
COMMENT ON COLUMN xp_transactions.multiplier IS 'Additive combo multiplier (§10). E.g. 1.0 + 0.5 on_time + 0.25 flow = 1.75.';
COMMENT ON COLUMN xp_transactions.bonus_type IS 'Compound bonus key: on_time, flow_zone, variable, streak, or combos like on_time+streak.';
COMMENT ON COLUMN xp_transactions.source_type IS 'Entity type: flashcard, quiz, reading, video, session, badge, system.';
COMMENT ON COLUMN xp_transactions.source_id IS 'UUID of triggering entity. Soft ref (no FK) — source items may be deleted.';


-- ─── INDEXES ───────────────────────────────────────────────
-- Follow patterns from axon-docs/database/rls-and-indexes.md

-- XP history queries: GET /gamification/xp-history?limit=20&offset=0
-- Student's own transaction log, ordered by most recent
CREATE INDEX IF NOT EXISTS idx_xp_tx_student
  ON xp_transactions(student_id, created_at DESC);

-- Institution-scoped XP queries: daily cap check, institution analytics
-- Used by award_xp() RPC to check xp_today efficiently
CREATE INDEX IF NOT EXISTS idx_xp_tx_institution
  ON xp_transactions(student_id, institution_id, created_at DESC);

-- Leaderboard: GET /gamification/leaderboard?institution_id=xxx&type=weekly
-- ⚠ Leaderboard uses xp_this_week ONLY, never total_xp (§6.5, §7.10)
CREATE INDEX IF NOT EXISTS idx_student_xp_leaderboard
  ON student_xp(institution_id, xp_this_week DESC);

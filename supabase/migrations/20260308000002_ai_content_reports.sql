-- ============================================================
-- Migration: AI Content Reports table (Fase 8B)
-- Date: 2026-03-08
-- Purpose: Allow students/teachers to report AI-generated content
--          that is incorrect, inappropriate, low quality, or irrelevant.
--
-- This table closes the feedback loop of the adaptive AI system:
--   generate-smart.ts creates content → student uses it →
--   student reports issues → dashboard shows quality metrics →
--   system improves.
--
-- Design decisions:
--   D1: Polymorphic FK (content_type + content_id) instead of
--       separate tables. One lifecycle, one dashboard query, one endpoint.
--       Trade-off: no DB-level FK on content_id → app-level validation.
--   D5: UNIQUE(content_type, content_id, reported_by) — one report
--       per user per content. Prevents spam/duplicate reports.
--   D6: No soft delete. Lifecycle managed by status field:
--       pending → reviewed → resolved | dismissed
--   D8: No RLS. Auth handled by Edge Functions (authenticate +
--       requireInstitutionRole), consistent with all AI module tables.
--   P4: No separate idx on (content_type, content_id) — the UNIQUE
--       constraint's B-tree already covers prefix queries.
--   P5: description limited to 2000 chars via CHECK.
--
-- Reviewer feedback incorporated:
--   Point 2: resolved_by semantics documented via COMMENT.
--   Point 3: ON DELETE CASCADE on reported_by — conscious decision,
--            consistent with project pattern. Documented via COMMENT.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_content_reports (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What was reported (polymorphic FK — D1)
  content_type      text          NOT NULL
    CHECK (content_type IN ('quiz_question', 'flashcard')),
  content_id        uuid          NOT NULL,

  -- Who reported
  reported_by       uuid          NOT NULL
    REFERENCES auth.users(id) ON DELETE CASCADE,
  institution_id    uuid          NOT NULL
    REFERENCES institutions(id) ON DELETE CASCADE,

  -- Report details
  reason            text          NOT NULL
    CHECK (reason IN ('incorrect', 'inappropriate', 'low_quality', 'irrelevant', 'other')),
  description       text
    CHECK (description IS NULL OR length(description) <= 2000),

  -- Resolution lifecycle
  status            text          NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'reviewed', 'resolved', 'dismissed')),
  resolved_by       uuid
    REFERENCES auth.users(id),
  resolution_note   text,
  resolved_at       timestamptz,

  -- Timestamps
  created_at        timestamptz   NOT NULL DEFAULT now(),
  updated_at        timestamptz   NOT NULL DEFAULT now(),

  -- D5: One report per user per content
  CONSTRAINT uq_ai_reports_one_per_user
    UNIQUE (content_type, content_id, reported_by)
);

-- ── Indexes ───────────────────────────────────────────────────
-- Note: idx on (content_type, content_id) is NOT needed — the
-- UNIQUE constraint already creates a B-tree that covers prefix
-- queries on those two columns (P4 fix).

-- Dashboard Par 3: "pending reports in my institution"
CREATE INDEX IF NOT EXISTS idx_ai_reports_institution_status
  ON ai_content_reports (institution_id, status);

-- "My reports" — student UI
CREATE INDEX IF NOT EXISTS idx_ai_reports_reported_by
  ON ai_content_reports (reported_by);

-- ── Trigger: auto-update updated_at (P3: per-table pattern) ──
CREATE OR REPLACE FUNCTION update_ai_content_reports_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ai_content_reports_updated_at ON ai_content_reports;
CREATE TRIGGER trg_ai_content_reports_updated_at
  BEFORE UPDATE ON ai_content_reports
  FOR EACH ROW EXECUTE FUNCTION update_ai_content_reports_updated_at();

-- ── Documentation ────────────────────────────────────────────
COMMENT ON TABLE ai_content_reports IS
  'Reports on AI-generated content (quiz_questions/flashcards). Feeds Fase 8 quality loop. Polymorphic FK: content_type + content_id.';

-- Point 2: resolved_by semantics
COMMENT ON COLUMN ai_content_reports.resolved_by IS
  'Last moderator who acted on this report. Set on reviewed/resolved/dismissed, NULLed on re-open to pending. Not strictly "resolver" — also tracks reviewer.';

-- Point 3: CASCADE decision
COMMENT ON COLUMN ai_content_reports.reported_by IS
  'ON DELETE CASCADE consistent with project pattern (video_views, flashcards, etc). If audit trail preservation becomes critical, migrate to SET NULL + DROP NOT NULL.';

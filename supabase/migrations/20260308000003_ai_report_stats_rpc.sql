-- ============================================================
-- Migration: AI Report Stats RPC (Fase 8C — Par 3)
-- Date: 2026-03-08
-- Purpose: Aggregate metrics for the AI content quality dashboard.
--          Returns counts by status, reason, and content_type,
--          plus resolution performance metrics.
--
-- This RPC powers the GET /ai/report-stats endpoint, giving
-- owners/admins/professors a single-query overview of AI content
-- quality within their institution.
--
-- Design decisions:
--   D1: LANGUAGE sql — pure aggregate query, no procedural logic.
--       sql functions are inlineable by the planner, allowing
--       better optimization than plpgsql for simple queries.
--   D2: SECURITY DEFINER — ai_content_reports has no RLS (D8 from
--       Par 2), but being explicit. Role validation happens in the
--       TypeScript endpoint (CONTENT_WRITE_ROLES), not in SQL.
--       Consistent with rag_analytics_summary / rag_embedding_coverage.
--   D3: Flat columns (14) instead of JSONB — consistent with
--       rag_analytics_summary pattern. PostgREST returns as a
--       plain JS object; TS can reshape if frontend needs nesting.
--   D4: FILTER clauses — PostgreSQL evaluates all FILTER conditions
--       in a single sequential pass over the filtered rows. No
--       multiple scans, no subqueries, no CTEs needed.
--   D5: 30-day default window — matches typical admin review cycle.
--       Frontend can override with from/to params for custom ranges.
--   D6: avg_resolution_hours only counts reports where resolved_at
--       IS NOT NULL (terminal states: resolved + dismissed).
--       In-progress reports (pending/reviewed) would skew the average.
--   D7: resolution_rate = (resolved + dismissed) / total.
--       Both terminal states count as "actioned" — a dismissed report
--       is not unresolved, it's intentionally closed.
--
-- Index usage:
--   Primary filter (institution_id) uses idx_ai_reports_institution_status.
--   The created_at range filter narrows within that subset.
--   Table is small (<10k rows/institution) — no additional index needed.
--
-- Error prevention:
--   E1: Division by zero in resolution_rate → CASE WHEN count(*) > 0
--   E2: NULL avg when no resolved reports → COALESCE(..., 0)
-- ============================================================

CREATE OR REPLACE FUNCTION get_ai_report_stats(
  p_institution_id UUID,
  p_from           TIMESTAMPTZ DEFAULT now() - interval '30 days',
  p_to             TIMESTAMPTZ DEFAULT now()
)
RETURNS TABLE (
  total_reports          BIGINT,
  pending_count          BIGINT,
  reviewed_count         BIGINT,
  resolved_count         BIGINT,
  dismissed_count        BIGINT,
  reason_incorrect       BIGINT,
  reason_inappropriate   BIGINT,
  reason_low_quality     BIGINT,
  reason_irrelevant      BIGINT,
  reason_other           BIGINT,
  type_quiz_question     BIGINT,
  type_flashcard         BIGINT,
  avg_resolution_hours   FLOAT,
  resolution_rate        FLOAT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT
    -- Total
    count(*)::BIGINT AS total_reports,

    -- By status (4 columns)
    count(*) FILTER (WHERE status = 'pending')::BIGINT    AS pending_count,
    count(*) FILTER (WHERE status = 'reviewed')::BIGINT   AS reviewed_count,
    count(*) FILTER (WHERE status = 'resolved')::BIGINT   AS resolved_count,
    count(*) FILTER (WHERE status = 'dismissed')::BIGINT  AS dismissed_count,

    -- By reason (5 columns)
    count(*) FILTER (WHERE reason = 'incorrect')::BIGINT      AS reason_incorrect,
    count(*) FILTER (WHERE reason = 'inappropriate')::BIGINT  AS reason_inappropriate,
    count(*) FILTER (WHERE reason = 'low_quality')::BIGINT    AS reason_low_quality,
    count(*) FILTER (WHERE reason = 'irrelevant')::BIGINT     AS reason_irrelevant,
    count(*) FILTER (WHERE reason = 'other')::BIGINT          AS reason_other,

    -- By content type (2 columns)
    count(*) FILTER (WHERE content_type = 'quiz_question')::BIGINT AS type_quiz_question,
    count(*) FILTER (WHERE content_type = 'flashcard')::BIGINT     AS type_flashcard,

    -- Resolution performance metrics
    -- D6: Only count reports with resolved_at (terminal states).
    -- E2: COALESCE to 0 when no reports have been resolved yet.
    COALESCE(
      EXTRACT(EPOCH FROM
        avg(resolved_at - created_at) FILTER (WHERE resolved_at IS NOT NULL)
      ) / 3600.0,
      0
    )::FLOAT AS avg_resolution_hours,

    -- D7: Both resolved + dismissed count as "actioned".
    -- E1: CASE prevents division by zero when total = 0.
    CASE
      WHEN count(*) > 0
      THEN (
        count(*) FILTER (WHERE status IN ('resolved', 'dismissed'))
      )::FLOAT / count(*)::FLOAT
      ELSE 0
    END AS resolution_rate

  FROM ai_content_reports
  WHERE institution_id = p_institution_id
    AND created_at >= p_from
    AND created_at <= p_to;
$$;

-- ── Documentation ────────────────────────────────────────────
COMMENT ON FUNCTION get_ai_report_stats(UUID, TIMESTAMPTZ, TIMESTAMPTZ) IS
  'Aggregate AI content report metrics for a given institution and date range. '
  'Returns 14 flat columns: counts by status/reason/content_type + resolution metrics. '
  'Role validation happens in the TS endpoint (CONTENT_WRITE_ROLES), not here.';

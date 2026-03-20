-- ============================================================================
-- Migration: 20260305_04_rag_query_log.sql
-- Purpose:   Fase 4 — Query logging + feedback loop for RAG chat
-- Depends:   institutions, summaries, auth.users (all pre-existing)
-- Applied:   Manually via SQL Editor (Supabase Dashboard)
-- ============================================================================

-- ┌──────────────────────────────────────────────────────────────────────┐
-- │ 1. TABLE: rag_query_log                                            │
-- │                                                                    │
-- │ Every RAG chat query produces one row. This gives us:              │
-- │   - Latency tracking (how fast is the RAG pipeline?)               │
-- │   - Quality signal (similarity scores, zero-result queries)        │
-- │   - User feedback (thumbs up/down → iterate on prompts/retrieval)  │
-- │                                                                    │
-- │ INSERT is done via adminClient (bypasses RLS) from chat.ts.        │
-- │ feedback is updated later by the user via PATCH /ai/rag-feedback.  │
-- └──────────────────────────────────────────────────────────────────────┘

CREATE TABLE IF NOT EXISTS rag_query_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id),
  institution_id  UUID NOT NULL REFERENCES institutions(id),
  query_text      TEXT NOT NULL,
  summary_id      UUID REFERENCES summaries(id),
  results_count   INT NOT NULL DEFAULT 0,
  top_similarity  FLOAT,
  avg_similarity  FLOAT,
  latency_ms      INT,
  search_type     TEXT NOT NULL DEFAULT 'hybrid',
  model_used      TEXT,
  feedback        SMALLINT CHECK (feedback IN (-1, 1)),  -- NULL=no feedback, 1=👍, -1=👎
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ┌──────────────────────────────────────────────────────────────────────┐
-- │ 2. INDEXES                                                         │
-- │                                                                    │
-- │ idx_inst_date:  Analytics queries filter by institution + date     │
-- │                 range. DESC on created_at because we almost always │
-- │                 want "most recent first".                          │
-- │                                                                    │
-- │ idx_user:       User's own query history (profile page, etc.)     │
-- │                                                                    │
-- │ idx_negative:   Partial index — only rows with feedback = -1.     │
-- │                 These are the ones we need to review to improve    │
-- │                 the system. Partial = tiny index, fast scans.      │
-- └──────────────────────────────────────────────────────────────────────┘

CREATE INDEX IF NOT EXISTS idx_rag_query_log_inst_date
  ON rag_query_log (institution_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_rag_query_log_user
  ON rag_query_log (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_rag_query_log_negative
  ON rag_query_log (institution_id, feedback)
  WHERE feedback = -1;

-- ┌──────────────────────────────────────────────────────────────────────┐
-- │ 3. ROW LEVEL SECURITY                                              │
-- │                                                                    │
-- │ No INSERT policy: inserts go through adminClient (bypass RLS).     │
-- │                                                                    │
-- │ SELECT policies (OR logic — either one can grant access):          │
-- │   - rag_log_select_own: users see their own logs                  │
-- │   - rag_log_select_institution: admins/owners see all inst. logs  │
-- │                                                                    │
-- │ UPDATE policy:                                                     │
-- │   - rag_log_update_feedback: users can only update the feedback   │
-- │     column of their own logs. The PATCH endpoint uses the user's  │
-- │     db client (not adminClient) so RLS enforces ownership.        │
-- └──────────────────────────────────────────────────────────────────────┘

ALTER TABLE rag_query_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY rag_log_select_own
  ON rag_query_log FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY rag_log_select_institution
  ON rag_query_log FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.user_id = auth.uid()
        AND m.institution_id = rag_query_log.institution_id
        AND m.role IN ('owner', 'admin')
        AND m.is_active = TRUE
    )
  );

CREATE POLICY rag_log_update_feedback
  ON rag_query_log FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ┌──────────────────────────────────────────────────────────────────────┐
-- │ 4. RPC: rag_analytics_summary                                      │
-- │                                                                    │
-- │ Returns aggregated metrics for a date range within an institution. │
-- │ SECURITY DEFINER because the calling TS code already validates     │
-- │ admin/owner role via requireInstitutionRole() before calling.      │
-- │                                                                    │
-- │ Returns a single row with:                                         │
-- │   total_queries, avg_similarity, avg_latency_ms,                  │
-- │   positive_feedback, negative_feedback, zero_result_queries        │
-- └──────────────────────────────────────────────────────────────────────┘

CREATE OR REPLACE FUNCTION rag_analytics_summary(
  p_institution_id UUID,
  p_from TIMESTAMPTZ DEFAULT now() - INTERVAL '7 days',
  p_to   TIMESTAMPTZ DEFAULT now()
)
RETURNS TABLE (
  total_queries       INT,
  avg_similarity      FLOAT,
  avg_latency_ms      INT,
  positive_feedback   INT,
  negative_feedback   INT,
  zero_result_queries INT
)
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT
    count(*)::INT                                          AS total_queries,
    round(avg(top_similarity)::NUMERIC, 3)::FLOAT          AS avg_similarity,
    round(avg(latency_ms)::NUMERIC, 0)::INT                AS avg_latency_ms,
    count(*) FILTER (WHERE feedback = 1)::INT               AS positive_feedback,
    count(*) FILTER (WHERE feedback = -1)::INT              AS negative_feedback,
    count(*) FILTER (WHERE results_count = 0)::INT          AS zero_result_queries
  FROM rag_query_log
  WHERE institution_id = p_institution_id
    AND created_at >= p_from
    AND created_at <= p_to;
$$;

-- ┌──────────────────────────────────────────────────────────────────────┐
-- │ 5. RPC: rag_embedding_coverage                                     │
-- │                                                                    │
-- │ Returns how many chunks have embeddings for a given institution.   │
-- │ SECURITY DEFINER because it joins chunks → summaries, and we      │
-- │ don't want to depend on those tables' RLS policies.                │
-- │ The TS code validates admin/owner role before calling.             │
-- │                                                                    │
-- │ Returns: total_chunks, chunks_with_embedding, coverage_pct        │
-- └──────────────────────────────────────────────────────────────────────┘

CREATE OR REPLACE FUNCTION rag_embedding_coverage(
  p_institution_id UUID
)
RETURNS TABLE (
  total_chunks          INT,
  chunks_with_embedding INT,
  coverage_pct          FLOAT
)
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT
    count(*)::INT                                             AS total_chunks,
    count(*) FILTER (WHERE ch.embedding IS NOT NULL)::INT     AS chunks_with_embedding,
    CASE
      WHEN count(*) = 0 THEN 0.0
      ELSE round(
        (count(*) FILTER (WHERE ch.embedding IS NOT NULL)::NUMERIC
         / count(*)::NUMERIC) * 100, 1
      )::FLOAT
    END                                                       AS coverage_pct
  FROM chunks ch
  JOIN summaries s ON s.id = ch.summary_id
  WHERE s.institution_id = p_institution_id
    AND s.deleted_at IS NULL
    AND s.is_active = TRUE;
$$;

-- ============================================================
-- Migration: Missing index for chunks table
-- Date: 2026-03-05
-- Fix: B2
--
-- Problem:
--   The chunks table is registered in crud-factory with:
--     parentKey: "summary_id", hasOrderIndex: true
--   This generates LIST queries like:
--     SELECT * FROM chunks WHERE summary_id = ? ORDER BY order_index
--   But NO index exists for this pattern.
--
-- Also used by:
--   - AI ingest route (reads chunks by summary_id in order)
--   - Smart Reader (renders chunks in order)
--   - RAG hybrid search (joins on chunks.summary_id)
--
-- The performance_indexes migration (20260302_01) covered
-- flashcards, quiz_questions, summaries, videos, quizzes,
-- reading_states, fsrs_states, bkt_states, reviews, etc.
-- but missed chunks.
--
-- Impact estimate (at 500K chunks):
--   Without index: ~200ms (sequential scan + sort)
--   With index:    ~2ms (index-only scan, pre-sorted)
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_chunks_summary_order
  ON chunks (summary_id, order_index);

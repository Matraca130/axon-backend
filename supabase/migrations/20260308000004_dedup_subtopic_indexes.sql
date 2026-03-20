-- ============================================================
-- Migration: Dedup Performance Indexes (Fase 8F)
-- Date: 2026-03-08
-- Purpose: Add composite indexes for the dedup queries in
--          generate-smart.ts Step 3 (subtopic-level + keyword fallback).
--
-- The dedup queries filter by:
--   created_by = ? AND source = 'ai' AND created_at >= ? AND subtopic_id IN (...)
--   created_by = ? AND source = 'ai' AND created_at >= ? AND keyword_id IN (...)
--
-- Without these indexes, PostgreSQL does a sequential scan on
-- quiz_questions/flashcards for every generate-smart call.
--
-- NOTE: Cannot use CONCURRENTLY inside a transaction.
-- For production with heavy traffic, run manually with CONCURRENTLY.
-- ============================================================

-- ═══════════════════════════════════════════════════════════════
-- 1. SUBTOPIC-LEVEL DEDUP (primary path — most targets after v2)
-- ═══════════════════════════════════════════════════════════════

-- quiz_questions: dedup by subtopic_id
CREATE INDEX IF NOT EXISTS idx_quiz_questions_dedup_subtopic
  ON quiz_questions (created_by, source, created_at DESC)
  WHERE subtopic_id IS NOT NULL;

-- flashcards: dedup by subtopic_id
CREATE INDEX IF NOT EXISTS idx_flashcards_dedup_subtopic
  ON flashcards (created_by, source, created_at DESC)
  WHERE subtopic_id IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════
-- 2. KEYWORD-LEVEL DEDUP (fallback for targets without subtopic)
-- ═══════════════════════════════════════════════════════════════

-- quiz_questions: dedup by keyword_id (fallback)
CREATE INDEX IF NOT EXISTS idx_quiz_questions_dedup_keyword
  ON quiz_questions (created_by, source, created_at DESC)
  WHERE subtopic_id IS NULL;

-- flashcards: dedup by keyword_id (fallback)
CREATE INDEX IF NOT EXISTS idx_flashcards_dedup_keyword
  ON flashcards (created_by, source, created_at DESC)
  WHERE subtopic_id IS NULL;

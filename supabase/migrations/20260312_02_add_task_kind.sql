-- ============================================================
-- Axon v4.5 — PR1a Migration: study_plan_tasks schema upgrade
--
-- FILE: supabase/migrations/20260312_02_add_task_kind.sql
-- REPO: Matraca130/axon-backend
--
-- PART 1: BUGFIX — Add Phase 5 columns that were never migrated
--   The frontend (useStudyPlans.createPlanFromWizard) sends
--   original_method, scheduled_date, estimated_minutes but these
--   columns never existed in the DB. The CRUD factory silently
--   dropped them, and the frontend mapper's fallback logic masked
--   the data loss on read-back.
--
-- PART 2: PR1a — Add task_kind for scheduling engine
--   Discriminates primary study tasks vs spaced reviews vs recaps.
--
-- BACKWARD COMPATIBLE:
--   - original_method defaults to NULL (mapper falls back to item_type mapping)
--   - scheduled_date defaults to NULL (mapper falls back to planCreatedAt + idx/3)
--   - estimated_minutes defaults to NULL (mapper falls back to METHOD_TIME_DEFAULTS)
--   - task_kind defaults to 'primary' (all existing tasks are primary)
-- ============================================================

-- ─── PART 1: Phase 5 columns (BUGFIX) ───────────────────────

-- original_method: preserves wizard method ID ('video', '3d', 'flashcard')
-- that may differ from the backend item_type ('reading', 'quiz', etc.)
ALTER TABLE study_plan_tasks
  ADD COLUMN IF NOT EXISTS original_method VARCHAR(50) DEFAULT NULL;

-- scheduled_date: the specific date this task is scheduled for
-- (ISO 8601 date string, e.g. '2026-03-15')
ALTER TABLE study_plan_tasks
  ADD COLUMN IF NOT EXISTS scheduled_date DATE DEFAULT NULL;

-- estimated_minutes: how long this task should take (from useStudyTimeEstimates)
ALTER TABLE study_plan_tasks
  ADD COLUMN IF NOT EXISTS estimated_minutes INTEGER DEFAULT NULL;

-- Index for date-range queries ("tasks for this week")
CREATE INDEX IF NOT EXISTS idx_spt_scheduled_date
  ON study_plan_tasks (scheduled_date)
  WHERE scheduled_date IS NOT NULL;

-- Composite: "pending tasks for a plan, ordered by date"
CREATE INDEX IF NOT EXISTS idx_spt_plan_date_status
  ON study_plan_tasks (study_plan_id, scheduled_date, status);

-- ─── PART 2: task_kind (PR1a) ────────────────────────────────

-- task_kind: discriminates primary study tasks from reviews/recaps
ALTER TABLE study_plan_tasks
  ADD COLUMN IF NOT EXISTS task_kind VARCHAR(10) DEFAULT 'primary';

-- CHECK constraint for valid values
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_study_plan_tasks_task_kind'
  ) THEN
    ALTER TABLE study_plan_tasks
      ADD CONSTRAINT chk_study_plan_tasks_task_kind
      CHECK (task_kind IN ('primary', 'review', 'recap'));
  END IF;
END $$;

-- Index for filtering by task_kind (analytics)
CREATE INDEX IF NOT EXISTS idx_spt_task_kind
  ON study_plan_tasks (task_kind);

-- Composite: "all reviews for a specific plan"
CREATE INDEX IF NOT EXISTS idx_spt_plan_id_task_kind
  ON study_plan_tasks (study_plan_id, task_kind);

-- ============================================================
-- VERIFICATION (run after migration):
--
-- 1. Check new columns exist:
--   SELECT column_name, data_type, column_default
--   FROM information_schema.columns
--   WHERE table_name = 'study_plan_tasks'
--     AND column_name IN ('original_method', 'scheduled_date',
--                         'estimated_minutes', 'task_kind');
--
-- 2. Check all existing rows have task_kind = 'primary':
--   SELECT task_kind, COUNT(*)
--   FROM study_plan_tasks
--   GROUP BY task_kind;
--
-- 3. Check Phase 5 columns are NULL (expected for existing data):
--   SELECT COUNT(*) AS total,
--          COUNT(original_method) AS has_method,
--          COUNT(scheduled_date) AS has_date,
--          COUNT(estimated_minutes) AS has_minutes
--   FROM study_plan_tasks;
-- ============================================================

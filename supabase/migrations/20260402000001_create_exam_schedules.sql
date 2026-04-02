-- ╔══════════════════════════════════════════════════════╗
-- ║  FSRS/BKT Calendar Sprint 0 — exam_schedules table ║
-- ╚══════════════════════════════════════════════════════╝
-- Exam-specific FSRS overrides: force-review scheduling for exam prep.
-- References exam_events (created in 20260327_01_calendar_v2_exam_events.sql).

CREATE TABLE IF NOT EXISTS exam_schedules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_event_id   UUID NOT NULL REFERENCES exam_events(id) ON DELETE CASCADE,
  flashcard_id    UUID NOT NULL,
  forced_due_at   TIMESTAMPTZ NOT NULL,
  original_due_at TIMESTAMPTZ NOT NULL,
  priority_weight NUMERIC(3, 2) DEFAULT 1.0,
  reason          TEXT DEFAULT 'exam_prep',
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(exam_event_id, flashcard_id)
);

-- ─── RLS ─────────────────────────────────────────────────────────
ALTER TABLE exam_schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY exam_schedules_student_all ON exam_schedules
  FOR ALL USING (
    exam_event_id IN (SELECT id FROM exam_events WHERE student_id = auth.uid())
  )
  WITH CHECK (
    exam_event_id IN (SELECT id FROM exam_events WHERE student_id = auth.uid())
  );

-- ─── Indexes ─────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_exam_schedules_exam_event
  ON exam_schedules(exam_event_id);

CREATE INDEX IF NOT EXISTS idx_exam_schedules_flashcard
  ON exam_schedules(flashcard_id);

CREATE INDEX IF NOT EXISTS idx_exam_schedules_forced_due
  ON exam_schedules(forced_due_at);

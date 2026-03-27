-- ╔══════════════════════════════════════╗
-- ║  AXON Calendar v2 Migration          ║
-- ╚══════════════════════════════════════╝
-- Session S-0A — exam_events table, indexes, RLS policies

-- ─── Table ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS exam_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  course_id      UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  date           DATE NOT NULL,
  time           TIME,
  location       TEXT,
  is_final       BOOLEAN DEFAULT true,
  exam_type      VARCHAR(50) DEFAULT 'written',
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now()
);

-- ─── Indexes ─────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_exam_events_student_date
  ON exam_events(student_id, date);

-- idx_fsrs_states_student_due already exists (verified in G-04) — NOT creating here.

-- CORRECTED: column is 'status' (text), not 'completed' (boolean)
CREATE INDEX IF NOT EXISTS idx_tasks_student_date
  ON study_plan_tasks(student_id, scheduled_date) WHERE status != 'completed';

-- ─── RLS ─────────────────────────────────────────────────────────
ALTER TABLE exam_events ENABLE ROW LEVEL SECURITY;

-- Student: full control over own exam events
CREATE POLICY exam_student_all ON exam_events
  USING (student_id = auth.uid())
  WITH CHECK (student_id = auth.uid());

-- Professor (A-05): read-only access to exam_events of courses they teach
CREATE POLICY exam_professor_read ON exam_events FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM course_enrollments ce
      WHERE ce.course_id = exam_events.course_id
        AND ce.user_id = auth.uid()
        AND ce.role = 'professor'
    )
  );

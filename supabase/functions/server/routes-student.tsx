/**
 * routes-student.tsx — Student-facing content & notes for Axon v4.4
 *
 * Professor-created learning instruments (CRUD via factory):
 *   flashcards      — keyword + summary scoped, soft-delete
 *   quizzes         — summary scoped, soft-delete (container for quiz questions)
 *   quiz_questions   — keyword + summary scoped, soft-delete, subtopic + quiz linked
 *   videos          — summary scoped, soft-delete, orderable
 *
 * Student-owned notes (CRUD via factory with scopeToUser):
 *   kw_student_notes   — per-keyword personal notes
 *   text_annotations   — highlight + notes on summaries
 *   video_notes        — timestamped notes on videos
 *
 * All routes are authenticated. RLS enforces row-level access.
 * scopeToUser ensures students can only see/edit their own notes.
 */

import { Hono } from "npm:hono";
import { registerCrud } from "./crud-factory.ts";

const studentRoutes = new Hono();

// ═════════════════════════════════════════════════════════════════════
// PROFESSOR-CREATED LEARNING INSTRUMENTS
// ═════════════════════════════════════════════════════════════════════

// 1. Flashcards — Keyword + Summary -> Flashcard (SACRED, soft-delete)
//    LIST requires summary_id. Optional filter by keyword_id.
//    CREATE requires both keyword_id and summary_id (via parentKey + requiredFields).
//    subtopic_id is optional (NULLABLE) — used by BKT algorithm (EV-5).
registerCrud(studentRoutes, {
  table: "flashcards",
  slug: "flashcards",
  parentKey: "summary_id",
  optionalFilters: ["keyword_id", "subtopic_id"],
  hasCreatedBy: true,
  hasUpdatedAt: true,
  hasOrderIndex: false,
  softDelete: true,
  hasIsActive: true,
  requiredFields: ["keyword_id", "front", "back"],
  createFields: ["keyword_id", "subtopic_id", "front", "back", "source"],
  updateFields: ["front", "back", "subtopic_id", "source", "is_active"],
});

// 2. Quizzes — Summary -> Quiz (SACRED, soft-delete)
//    Container for quiz questions. LIST requires summary_id.
//    CREATE requires title. source defaults to "manual".
registerCrud(studentRoutes, {
  table: "quizzes",
  slug: "quizzes",
  parentKey: "summary_id",
  hasCreatedBy: true,
  hasUpdatedAt: true,
  hasOrderIndex: false,
  softDelete: true,
  hasIsActive: true,
  requiredFields: ["title"],
  createFields: ["title", "description", "source"],
  updateFields: ["title", "description", "source", "is_active"],
});

// 3. Quiz Questions — Keyword + Summary -> QuizQuestion (SACRED, soft-delete)
//    LIST requires summary_id. Optional filters: keyword_id, question_type,
//    difficulty, subtopic_id (for BKT), quiz_id (to get questions of a quiz).
//    subtopic_id links question to BKT algorithm (EV-5).
//    quiz_id links question to its parent quiz container.
registerCrud(studentRoutes, {
  table: "quiz_questions",
  slug: "quiz-questions",
  parentKey: "summary_id",
  optionalFilters: ["keyword_id", "question_type", "difficulty", "subtopic_id", "quiz_id"],
  hasCreatedBy: true,
  hasUpdatedAt: true,
  hasOrderIndex: false,
  softDelete: true,
  hasIsActive: true,
  requiredFields: ["keyword_id", "question_type", "question", "correct_answer"],
  createFields: [
    "keyword_id",
    "question_type",
    "question",
    "options",
    "correct_answer",
    "explanation",
    "difficulty",
    "source",
    "subtopic_id",
    "quiz_id",
  ],
  updateFields: [
    "question_type",
    "question",
    "options",
    "correct_answer",
    "explanation",
    "difficulty",
    "source",
    "is_active",
    "subtopic_id",
    "quiz_id",
  ],
});

// 4. Videos — Summary -> Video (SACRED, soft-delete, orderable)
registerCrud(studentRoutes, {
  table: "videos",
  slug: "videos",
  parentKey: "summary_id",
  hasCreatedBy: true,
  hasUpdatedAt: true,
  hasOrderIndex: true,
  softDelete: true,
  hasIsActive: true,
  requiredFields: ["title", "url"],
  createFields: ["title", "url", "platform", "duration_seconds", "order_index"],
  updateFields: [
    "title",
    "url",
    "platform",
    "duration_seconds",
    "order_index",
    "is_active",
  ],
});

// ═════════════════════════════════════════════════════════════════════
// STUDENT-OWNED NOTES
// scopeToUser = "student_id" → auto-set on create, auto-filtered on list/update/delete
// ═════════════════════════════════════════════════════════════════════

// 5. Keyword Student Notes — per-keyword personal notes
//    Has deleted_at but NO is_active column.
registerCrud(studentRoutes, {
  table: "kw_student_notes",
  slug: "kw-student-notes",
  parentKey: "keyword_id",
  scopeToUser: "student_id",
  hasCreatedBy: false,
  hasUpdatedAt: true,
  hasOrderIndex: false,
  softDelete: true,
  hasIsActive: false,
  requiredFields: ["note"],
  createFields: ["note"],
  updateFields: ["note"],
});

// 6. Text Annotations — highlights + notes on summaries
//    Has deleted_at but NO is_active column.
registerCrud(studentRoutes, {
  table: "text_annotations",
  slug: "text-annotations",
  parentKey: "summary_id",
  scopeToUser: "student_id",
  hasCreatedBy: false,
  hasUpdatedAt: true,
  hasOrderIndex: false,
  softDelete: true,
  hasIsActive: false,
  requiredFields: ["start_offset", "end_offset"],
  createFields: ["start_offset", "end_offset", "color", "note"],
  updateFields: ["color", "note"],
});

// 7. Video Notes — timestamped notes on videos
//    Has deleted_at but NO is_active column.
registerCrud(studentRoutes, {
  table: "video_notes",
  slug: "video-notes",
  parentKey: "video_id",
  scopeToUser: "student_id",
  hasCreatedBy: false,
  hasUpdatedAt: true,
  hasOrderIndex: false,
  softDelete: true,
  hasIsActive: false,
  requiredFields: ["note"],
  createFields: ["timestamp_seconds", "note"],
  updateFields: ["timestamp_seconds", "note"],
});

export { studentRoutes };

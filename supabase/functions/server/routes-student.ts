/**
 * routes-student.ts — Student-facing content & notes for Axon v4.4
 *
 * Professor-created learning instruments (CRUD via factory):
 *   flashcards      — keyword + summary scoped, soft-delete
 *   quiz_questions   — keyword + summary scoped, soft-delete
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

// ═══════════════════════════════════════════════════════════════════════
// PROFESSOR-CREATED LEARNING INSTRUMENTS
// ═══════════════════════════════════════════════════════════════════════

// 1. Flashcards — Keyword + Summary -> Flashcard (SACRED, soft-delete)
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
  createFields: ["keyword_id", "subtopic_id", "front", "back", "source", "front_image_url", "back_image_url"],
  updateFields: ["front", "back", "source", "subtopic_id", "is_active", "front_image_url", "back_image_url"],
});

// ── Student-owned flashcards (scopeToUser) ─────────────────
// Students can CRUD their own flashcards only.
// Professor flashcards route above remains for read-only access.
registerCrud(studentRoutes, {
  table: "flashcards",
  slug: "my-flashcards",
  parentKey: "summary_id",
  optionalFilters: ["keyword_id", "subtopic_id"],
  scopeToUser: "created_by",
  hasCreatedBy: true,
  hasUpdatedAt: true,
  hasOrderIndex: false,
  softDelete: true,
  hasIsActive: true,
  requiredFields: ["keyword_id", "front", "back"],
  createFields: ["keyword_id", "subtopic_id", "front", "back", "source", "front_image_url", "back_image_url"],
  updateFields: ["front", "back", "subtopic_id", "is_active", "front_image_url", "back_image_url"],
});

// 2. Quiz Questions — Keyword/Block + Summary -> QuizQuestion (SACRED, soft-delete)
//    ADR-001: block_id added for per-block quiz with domain tracking.
//    keyword_id removed from requiredFields — per-block questions may not need a keyword.
registerCrud(studentRoutes, {
  table: "quiz_questions",
  slug: "quiz-questions",
  parentKey: "summary_id",
  optionalFilters: ["keyword_id", "block_id", "question_type", "difficulty", "subtopic_id", "quiz_id"],
  hasCreatedBy: true,
  hasUpdatedAt: true,
  hasOrderIndex: false,
  softDelete: true,
  hasIsActive: true,
  requiredFields: ["question_type", "question", "correct_answer"],
  createFields: [
    "keyword_id",
    "block_id",
    "subtopic_id",
    "quiz_id",
    "question_type",
    "question",
    "options",
    "correct_answer",
    "explanation",
    "difficulty",
    "source",
  ],
  updateFields: [
    "question_type",
    "question",
    "options",
    "correct_answer",
    "explanation",
    "difficulty",
    "source",
    "subtopic_id",
    "quiz_id",
    "block_id",
    "is_active",
  ],
});

// 2b. Quizzes — Summary -> Quiz (CRUD, soft-delete)
registerCrud(studentRoutes, {
  table: "quizzes",
  slug: "quizzes",
  parentKey: "summary_id",
  optionalFilters: ["source", "is_active"],
  hasCreatedBy: true,
  hasUpdatedAt: true,
  hasOrderIndex: false,
  softDelete: true,
  hasIsActive: true,
  requiredFields: ["title", "source"],
  createFields: ["title", "description", "source", "time_limit_seconds"],
  updateFields: ["title", "description", "is_active", "time_limit_seconds"],
});

// 3. Videos — Summary -> Video (SACRED, soft-delete, orderable)
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

// ═══════════════════════════════════════════════════════════════════════
// STUDENT-OWNED NOTES
// ═══════════════════════════════════════════════════════════════════════

// 4. Keyword Student Notes — per-keyword personal notes
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

// 5. Text Annotations — highlights + notes on summaries
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

// 6. Video Notes — timestamped notes on videos
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

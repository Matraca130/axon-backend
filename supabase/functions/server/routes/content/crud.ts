/**
 * routes/content/crud.ts — Content hierarchy CRUD registrations
 *
 * 9 registerCrud calls covering the full content hierarchy:
 * courses → semesters → sections → topics → summaries → chunks → summary_blocks → keywords → subtopics
 *
 * No custom endpoints here — only factory-generated CRUD.
 *
 * Fase 5: summaries config includes `afterWrite: onSummaryWrite`
 * to trigger auto-ingest (chunking + embedding) on POST/PUT.
 */

import { Hono } from "npm:hono";
import { registerCrud } from "../../crud-factory.ts";
import { onSummaryWrite } from "../../summary-hook.ts";

export const contentCrudRoutes = new Hono();

// 1. Courses — Institution -> Course
registerCrud(contentCrudRoutes, {
  table: "courses",
  slug: "courses",
  parentKey: "institution_id",
  hasCreatedBy: true,
  hasUpdatedAt: true,
  hasOrderIndex: true,
  softDelete: true,
  hasIsActive: true,
  requiredFields: ["name"],
  createFields: ["name", "description", "order_index"],
  updateFields: ["name", "description", "order_index", "is_active"],
  cascadeChildren: [{ table: "semesters", fk: "course_id" }],
});

// 2. Semesters — Course -> Semester
registerCrud(contentCrudRoutes, {
  table: "semesters",
  slug: "semesters",
  parentKey: "course_id",
  hasCreatedBy: true,
  hasUpdatedAt: true,
  hasOrderIndex: true,
  softDelete: true,
  hasIsActive: true,
  requiredFields: ["name"],
  createFields: ["name", "order_index"],
  updateFields: ["name", "order_index", "is_active"],
  cascadeChildren: [{ table: "sections", fk: "semester_id" }],
});

// 3. Sections — Semester -> Section
registerCrud(contentCrudRoutes, {
  table: "sections",
  slug: "sections",
  parentKey: "semester_id",
  hasCreatedBy: true,
  hasUpdatedAt: true,
  hasOrderIndex: true,
  softDelete: true,
  hasIsActive: true,
  requiredFields: ["name"],
  createFields: ["name", "order_index"],
  updateFields: ["name", "order_index", "is_active"],
  cascadeChildren: [{ table: "topics", fk: "section_id" }],
});

// 4. Topics — Section -> Topic
registerCrud(contentCrudRoutes, {
  table: "topics",
  slug: "topics",
  parentKey: "section_id",
  hasCreatedBy: true,
  hasUpdatedAt: true,
  hasOrderIndex: true,
  softDelete: true,
  hasIsActive: true,
  requiredFields: ["name"],
  createFields: ["name", "order_index"],
  updateFields: ["name", "order_index", "is_active"],
  cascadeChildren: [{ table: "summaries", fk: "topic_id" }],
});

// 5. Summaries — Topic -> Summary (SACRED, soft-delete)
//    afterWrite: triggers auto-ingest (chunking + embedding) on POST/PUT.
//    See summary-hook.ts for trigger conditions and guards.
registerCrud(contentCrudRoutes, {
  table: "summaries",
  slug: "summaries",
  parentKey: "topic_id",
  hasCreatedBy: true,
  hasUpdatedAt: true,
  hasOrderIndex: true,
  softDelete: true,
  requiredFields: ["title"],
  createFields: ["title", "content_markdown", "status", "order_index", "estimated_study_minutes"],
  updateFields: [
    "title",
    "content_markdown",
    "status",
    "order_index",
    "is_active",
    "estimated_study_minutes",
  ],
  listFields: "id, title, topic_id, status, order_index, estimated_study_minutes, is_active, created_at, updated_at",
  afterWrite: onSummaryWrite,
});

// 6. Chunks — Summary -> Chunk (NO updated_at, NO created_by, NO is_active)
registerCrud(contentCrudRoutes, {
  table: "chunks",
  slug: "chunks",
  parentKey: "summary_id",
  hasCreatedBy: false,
  hasUpdatedAt: false,
  hasOrderIndex: true,
  requiredFields: ["content"],
  createFields: ["content", "order_index", "metadata"],
  updateFields: ["content", "order_index", "metadata"],
});

// 7. Summary Blocks — Summary -> Block (Smart Reader)
// Column is "type" NOT "block_type" (see Guidelines.md)
registerCrud(contentCrudRoutes, {
  table: "summary_blocks",
  slug: "summary-blocks",
  parentKey: "summary_id",
  hasCreatedBy: false,
  hasUpdatedAt: false,
  hasOrderIndex: true,
  hasIsActive: true,
  requiredFields: ["type", "content"],
  createFields: ["type", "content", "order_index", "heading_text", "heading_level", "is_active"],
  updateFields: ["type", "content", "order_index", "heading_text", "heading_level", "is_active"],
});

// 8. Keywords — Summary -> Keyword (SACRED, soft-delete)
//    v4.2: Added clinical_priority (0-1 float) and is_foundation (boolean)
//    for NeedScore multiplier and prerequisite tracking.
registerCrud(contentCrudRoutes, {
  table: "keywords",
  slug: "keywords",
  parentKey: "summary_id",
  hasCreatedBy: true,
  hasUpdatedAt: true,
  hasOrderIndex: false,
  softDelete: true,
  requiredFields: ["name"],
  createFields: ["name", "definition", "priority", "clinical_priority", "is_foundation"],
  updateFields: ["name", "definition", "priority", "is_active", "clinical_priority", "is_foundation"],
});

// 9. Subtopics — Keyword -> Subtopic (SACRED, soft-delete, NO updated_at)
registerCrud(contentCrudRoutes, {
  table: "subtopics",
  slug: "subtopics",
  parentKey: "keyword_id",
  hasCreatedBy: false,
  hasUpdatedAt: false,
  hasOrderIndex: true,
  softDelete: true,
  requiredFields: ["name"],
  createFields: ["name", "order_index"],
  updateFields: ["name", "order_index", "is_active"],
});

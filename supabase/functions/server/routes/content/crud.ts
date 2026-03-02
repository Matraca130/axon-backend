/**
 * routes/content/crud.ts — Content hierarchy CRUD registrations
 *
 * 10 registerCrud calls covering the full content hierarchy:
 * courses → semesters → sections → topics → summaries → chunks → summary_blocks → keywords → subtopics
 *
 * No custom endpoints here — only factory-generated CRUD.
 */

import { Hono } from "npm:hono";
import { registerCrud } from "../../crud-factory.ts";

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
});

// 5. Summaries — Topic -> Summary (SACRED, soft-delete)
registerCrud(contentCrudRoutes, {
  table: "summaries",
  slug: "summaries",
  parentKey: "topic_id",
  hasCreatedBy: true,
  hasUpdatedAt: true,
  hasOrderIndex: true,
  softDelete: true,
  requiredFields: ["title"],
  createFields: ["title", "content_markdown", "status", "order_index"],
  updateFields: [
    "title",
    "content_markdown",
    "status",
    "order_index",
    "is_active",
  ],
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
registerCrud(contentCrudRoutes, {
  table: "keywords",
  slug: "keywords",
  parentKey: "summary_id",
  hasCreatedBy: true,
  hasUpdatedAt: true,
  hasOrderIndex: false,
  softDelete: true,
  requiredFields: ["name"],
  createFields: ["name", "definition", "priority"],
  updateFields: ["name", "definition", "priority", "is_active"],
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

/**
 * routes/content/crud.ts — Content hierarchy CRUD registrations
 *
 * 10 registerCrud calls covering the full content hierarchy:
 * courses → semesters → sections → topics → summaries → chunks → summary_blocks → keywords → subtopics
 *
 * Fase 5: Summaries now have onAfterCreate/onAfterUpdate hooks that
 * trigger automatic chunking + embedding via autoChunkAndEmbed().
 * The hook only fires when content_markdown is present (create) or
 * was included in the update payload.
 *
 * No custom endpoints here — only factory-generated CRUD.
 */

import { Hono } from "npm:hono";
import { registerCrud } from "../../crud-factory.ts";
import { autoChunkAndEmbed } from "../../auto-ingest.ts";

export const contentCrudRoutes = new Hono();

// ─── Fase 5: Auto-ingest hook for summaries ──────────────────────
// Fire-and-forget: chunks + embeds the summary's markdown after
// create or update. Errors are logged but never block the response.

function triggerAutoIngest(row: Record<string, unknown>) {
  const summaryId = row.id as string;
  const contentMarkdown = row.content_markdown as string | null;

  // Only trigger if there's content to chunk
  if (!summaryId || !contentMarkdown || contentMarkdown.trim().length === 0) {
    return;
  }

  // Resolve institution_id: summaries don't have it directly,
  // but autoChunkAndEmbed uses adminClient and doesn't need it
  // for DB operations. We pass empty string as placeholder.
  autoChunkAndEmbed(summaryId, "")
    .then((result) => {
      console.log(
        `[Auto-Ingest] ${result.chunks_created} chunks, ` +
        `${result.embeddings_generated} embeds for summary ${summaryId} ` +
        `(${result.elapsed_ms}ms)`,
      );
    })
    .catch((err) => {
      console.error(
        `[Auto-Ingest] Failed for summary ${summaryId}:`,
        (err as Error).message,
      );
    });
}

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
//    Fase 5: onAfterCreate + onAfterUpdate trigger auto-ingest
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
  onAfterCreate: ({ row }) => triggerAutoIngest(row),
  onAfterUpdate: ({ row }) => triggerAutoIngest(row),
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

/**
 * Tests for crud-factory exported helpers
 *
 * Tests cover:
 *   1. Constants: MAX_PAGINATION_LIMIT, DEFAULT_PAGINATION_LIMIT
 *   2. PARENT_KEY_TO_TABLE: content hierarchy mapping
 *   3. isContentHierarchyParent: content hierarchy detection
 *
 * Run: deno test supabase/functions/server/tests/crud_factory_test.ts
 */

import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  MAX_PAGINATION_LIMIT,
  DEFAULT_PAGINATION_LIMIT,
  PARENT_KEY_TO_TABLE,
  isContentHierarchyParent,
} from "../crud-factory.ts";

// ═════════════════════════════════════════════════════════
// 1. Constants
// ═════════════════════════════════════════════════════════

Deno.test("Constants: MAX_PAGINATION_LIMIT = 500", () => {
  assertEquals(MAX_PAGINATION_LIMIT, 500);
});

Deno.test("Constants: DEFAULT_PAGINATION_LIMIT = 100", () => {
  assertEquals(DEFAULT_PAGINATION_LIMIT, 100);
});

// ═════════════════════════════════════════════════════════
// 2. PARENT_KEY_TO_TABLE mapping
// ═════════════════════════════════════════════════════════

Deno.test("PARENT_KEY_TO_TABLE: has 7 content hierarchy mappings", () => {
  assertEquals(Object.keys(PARENT_KEY_TO_TABLE).length, 7);
});

Deno.test("PARENT_KEY_TO_TABLE: course_id -> courses", () => {
  assertEquals(PARENT_KEY_TO_TABLE.course_id, "courses");
});

Deno.test("PARENT_KEY_TO_TABLE: semester_id -> semesters", () => {
  assertEquals(PARENT_KEY_TO_TABLE.semester_id, "semesters");
});

Deno.test("PARENT_KEY_TO_TABLE: section_id -> sections", () => {
  assertEquals(PARENT_KEY_TO_TABLE.section_id, "sections");
});

Deno.test("PARENT_KEY_TO_TABLE: topic_id -> topics", () => {
  assertEquals(PARENT_KEY_TO_TABLE.topic_id, "topics");
});

Deno.test("PARENT_KEY_TO_TABLE: summary_id -> summaries", () => {
  assertEquals(PARENT_KEY_TO_TABLE.summary_id, "summaries");
});

Deno.test("PARENT_KEY_TO_TABLE: keyword_id -> keywords", () => {
  assertEquals(PARENT_KEY_TO_TABLE.keyword_id, "keywords");
});

Deno.test("PARENT_KEY_TO_TABLE: model_id -> models_3d", () => {
  assertEquals(PARENT_KEY_TO_TABLE.model_id, "models_3d");
});

// ═════════════════════════════════════════════════════════
// 3. isContentHierarchyParent
// ═════════════════════════════════════════════════════════

Deno.test("isContentHierarchyParent: institution_id is content hierarchy (direct)", () => {
  assertEquals(isContentHierarchyParent("institution_id"), true);
});

Deno.test("isContentHierarchyParent: all 7 mapped keys return true", () => {
  for (const key of Object.keys(PARENT_KEY_TO_TABLE)) {
    assertEquals(
      isContentHierarchyParent(key),
      true,
      `Expected ${key} to be content hierarchy parent`,
    );
  }
});

Deno.test("isContentHierarchyParent: study_plan_id is NOT content hierarchy (A-10)", () => {
  assertEquals(isContentHierarchyParent("study_plan_id"), false);
});

Deno.test("isContentHierarchyParent: unknown keys return false", () => {
  assertEquals(isContentHierarchyParent("random_id"), false);
  assertEquals(isContentHierarchyParent("user_id"), false);
  assertEquals(isContentHierarchyParent(""), false);
  assertEquals(isContentHierarchyParent("video_id"), false);
});

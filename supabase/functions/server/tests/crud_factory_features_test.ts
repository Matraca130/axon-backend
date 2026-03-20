/**
 * Tests for crud-factory.ts — Ronda 2 feature additions
 *
 * Tests cover:
 *   1. listFields config defaults to "*"
 *   2. cascadeChildren config structure
 *
 * These test the CrudConfig type contract, not full route integration
 * (which requires a running Hono server + Supabase).
 *
 * Run: deno test supabase/functions/server/tests/crud_factory_features_test.ts
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { CrudConfig } from "../crud-factory.ts";

// ═════════════════════════════════════════════════════════════════
// 1. listFields config defaults to "*"
// ═════════════════════════════════════════════════════════════════

Deno.test("CrudConfig: listFields defaults to undefined (factory uses || '*')", () => {
  const config: CrudConfig = {
    table: "test_table",
    slug: "test",
    createFields: ["name"],
    updateFields: ["name"],
  };

  // When listFields is not set, it should be undefined
  assertEquals(config.listFields, undefined);

  // The factory code uses: cfg.listFields || "*"
  const effectiveListFields = config.listFields || "*";
  assertEquals(effectiveListFields, "*");
});

Deno.test("CrudConfig: listFields can be set to specific columns", () => {
  const config: CrudConfig = {
    table: "summaries",
    slug: "summaries",
    parentKey: "topic_id",
    createFields: ["title", "content_markdown"],
    updateFields: ["title", "content_markdown"],
    listFields: "id, title, created_at, updated_at",
  };

  assertEquals(config.listFields, "id, title, created_at, updated_at");
  // Should NOT be "*"
  assertEquals(config.listFields !== "*", true);
});

Deno.test("CrudConfig: listFields || '*' pattern works for both cases", () => {
  // Case 1: undefined → defaults to "*"
  const config1: CrudConfig = {
    table: "t1",
    slug: "s1",
    createFields: [],
    updateFields: [],
  };
  assertEquals(config1.listFields || "*", "*");

  // Case 2: explicit value → uses that value
  const config2: CrudConfig = {
    table: "t2",
    slug: "s2",
    createFields: [],
    updateFields: [],
    listFields: "id, name",
  };
  assertEquals(config2.listFields || "*", "id, name");

  // Case 3: empty string → falls back to "*" (|| treats "" as falsy)
  const config3: CrudConfig = {
    table: "t3",
    slug: "s3",
    createFields: [],
    updateFields: [],
    listFields: "",
  };
  assertEquals(config3.listFields || "*", "*");
});

// ═════════════════════════════════════════════════════════════════
// 2. cascadeChildren config structure
// ═════════════════════════════════════════════════════════════════

Deno.test("CrudConfig: cascadeChildren defaults to undefined", () => {
  const config: CrudConfig = {
    table: "courses",
    slug: "courses",
    createFields: ["name"],
    updateFields: ["name"],
    softDelete: true,
  };

  assertEquals(config.cascadeChildren, undefined);
});

Deno.test("CrudConfig: cascadeChildren accepts array of { table, fk }", () => {
  const config: CrudConfig = {
    table: "topics",
    slug: "topics",
    parentKey: "section_id",
    createFields: ["title"],
    updateFields: ["title"],
    softDelete: true,
    cascadeChildren: [
      { table: "subtopics", fk: "topic_id" },
      { table: "summaries", fk: "topic_id" },
    ],
  };

  assertEquals(config.cascadeChildren!.length, 2);
  assertEquals(config.cascadeChildren![0].table, "subtopics");
  assertEquals(config.cascadeChildren![0].fk, "topic_id");
  assertEquals(config.cascadeChildren![1].table, "summaries");
  assertEquals(config.cascadeChildren![1].fk, "topic_id");
});

Deno.test("CrudConfig: cascadeChildren empty array is valid (no cascades)", () => {
  const config: CrudConfig = {
    table: "sections",
    slug: "sections",
    createFields: ["title"],
    updateFields: ["title"],
    softDelete: true,
    cascadeChildren: [],
  };

  assertEquals(config.cascadeChildren!.length, 0);

  // The factory code guards with: cfg.cascadeChildren && cfg.cascadeChildren.length > 0
  const shouldCascade = config.cascadeChildren && config.cascadeChildren.length > 0;
  assertEquals(shouldCascade, false);
});

Deno.test("CrudConfig: cascadeChildren with single child", () => {
  const config: CrudConfig = {
    table: "keywords",
    slug: "keywords",
    parentKey: "keyword_id",
    createFields: ["term"],
    updateFields: ["term"],
    softDelete: true,
    cascadeChildren: [
      { table: "flashcards", fk: "keyword_id" },
    ],
  };

  assertEquals(config.cascadeChildren!.length, 1);
  assertEquals(config.cascadeChildren![0].table, "flashcards");
  assertEquals(config.cascadeChildren![0].fk, "keyword_id");
});

Deno.test("CrudConfig: cascadeChildren only applies when softDelete is true", () => {
  // Without softDelete, cascadeChildren has no effect in the factory.
  // But the config still accepts it structurally.
  const config: CrudConfig = {
    table: "temp_table",
    slug: "temp",
    createFields: ["name"],
    updateFields: ["name"],
    softDelete: false,
    cascadeChildren: [
      { table: "child_table", fk: "parent_id" },
    ],
  };

  // Config is valid — but the factory won't use cascadeChildren
  // because the DELETE branch for hard-delete doesn't check cascadeChildren.
  assertEquals(config.softDelete, false);
  assertEquals(config.cascadeChildren!.length, 1);
});

// ═════════════════════════════════════════════════════════════════
// 3. Combined config: listFields + cascadeChildren
// ═════════════════════════════════════════════════════════════════

Deno.test("CrudConfig: full config with listFields + cascadeChildren + afterWrite", () => {
  let hookCalled = false;

  const config: CrudConfig = {
    table: "topics",
    slug: "topics",
    parentKey: "section_id",
    optionalFilters: ["keyword_id"],
    hasCreatedBy: true,
    hasUpdatedAt: true,
    hasOrderIndex: true,
    softDelete: true,
    hasIsActive: true,
    requiredFields: ["title"],
    createFields: ["title", "description"],
    updateFields: ["title", "description"],
    listFields: "id, title, order_index, created_at",
    cascadeChildren: [
      { table: "subtopics", fk: "topic_id" },
    ],
    afterWrite: () => { hookCalled = true; },
  };

  assertEquals(config.listFields, "id, title, order_index, created_at");
  assertEquals(config.cascadeChildren!.length, 1);
  assertEquals(typeof config.afterWrite, "function");

  // Verify afterWrite is callable
  config.afterWrite!({ action: "create", row: { id: "test" }, userId: "u1" });
  assertEquals(hookCalled, true);
});

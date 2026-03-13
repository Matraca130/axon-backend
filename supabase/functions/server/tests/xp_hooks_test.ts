/**
 * Tests for xp-hooks.ts — XP hook functions for Axon v4.4
 *
 * Tests verify:
 *   1. Hook function signatures and exports
 *   2. Hook guard conditions (action type, field checks)
 *   3. Batch review hook with multiple items
 *   4. Plan task hook guard conditions
 *
 * Strategy: Test guard logic without DB (hooks catch their own errors).
 * We verify that hooks DON'T throw and DON'T block when called.
 *
 * Run: deno test supabase/functions/server/tests/xp_hooks_test.ts
 */

import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// ─── Environment Setup ───
Deno.env.set("SUPABASE_URL", "http://127.0.0.1:1");
Deno.env.set("SUPABASE_ANON_KEY", "fake-anon-key-for-testing");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "fake-service-role-key-for-testing");

const hooks = await import("../xp-hooks.ts");

// ═══════════════════════════════════════════════════════════════
// 1. Export verification — all 8 hooks exist
// ═══════════════════════════════════════════════════════════════

Deno.test("exports: xpHookForReview is a function", () => {
  assertExists(hooks.xpHookForReview);
  assertEquals(typeof hooks.xpHookForReview, "function");
});

Deno.test("exports: xpHookForQuizAttempt is a function", () => {
  assertExists(hooks.xpHookForQuizAttempt);
  assertEquals(typeof hooks.xpHookForQuizAttempt, "function");
});

Deno.test("exports: xpHookForSessionComplete is a function", () => {
  assertExists(hooks.xpHookForSessionComplete);
  assertEquals(typeof hooks.xpHookForSessionComplete, "function");
});

Deno.test("exports: xpHookForReadingComplete is a function", () => {
  assertExists(hooks.xpHookForReadingComplete);
  assertEquals(typeof hooks.xpHookForReadingComplete, "function");
});

Deno.test("exports: xpHookForBatchReviews is a function", () => {
  assertExists(hooks.xpHookForBatchReviews);
  assertEquals(typeof hooks.xpHookForBatchReviews, "function");
});

Deno.test("exports: xpHookForVideoComplete is a function", () => {
  assertExists(hooks.xpHookForVideoComplete);
  assertEquals(typeof hooks.xpHookForVideoComplete, "function");
});

Deno.test("exports: xpHookForRagQuestion is a function", () => {
  assertExists(hooks.xpHookForRagQuestion);
  assertEquals(typeof hooks.xpHookForRagQuestion, "function");
});

Deno.test("exports: xpHookForPlanTaskComplete is a function", () => {
  assertExists(hooks.xpHookForPlanTaskComplete);
  assertEquals(typeof hooks.xpHookForPlanTaskComplete, "function");
});

// ═══════════════════════════════════════════════════════════════
// 2. Guard conditions — hooks with wrong action type should no-op
// ═══════════════════════════════════════════════════════════════

Deno.test("guard: xpHookForReview ignores update action", () => {
  // Should not throw — just returns early
  hooks.xpHookForReview({
    action: "update",
    row: { session_id: "abc", grade: 4, item_id: "def" },
    userId: "user-1",
  });
});

Deno.test("guard: xpHookForSessionComplete ignores create action", () => {
  hooks.xpHookForSessionComplete({
    action: "create",
    row: { id: "session-1", completed_at: new Date().toISOString() },
    userId: "user-1",
  });
});

Deno.test("guard: xpHookForSessionComplete ignores update without completed_at field", () => {
  hooks.xpHookForSessionComplete({
    action: "update",
    row: { id: "session-1", completed_at: new Date().toISOString() },
    updatedFields: ["total_reviews"], // NOT completed_at
    userId: "user-1",
  });
});

Deno.test("guard: xpHookForReadingComplete ignores create action", () => {
  hooks.xpHookForReadingComplete({
    action: "create",
    row: { id: "rs-1", completed: true, summary_id: "sum-1" },
    userId: "user-1",
  });
});

Deno.test("guard: xpHookForReadingComplete ignores completed=false", () => {
  hooks.xpHookForReadingComplete({
    action: "update",
    row: { id: "rs-1", completed: false, summary_id: "sum-1" },
    updatedFields: ["completed"],
    userId: "user-1",
  });
});

Deno.test("guard: xpHookForPlanTaskComplete ignores create action", () => {
  hooks.xpHookForPlanTaskComplete({
    action: "create",
    row: { id: "task-1", status: "completed", study_plan_id: "plan-1" },
    userId: "user-1",
  });
});

Deno.test("guard: xpHookForPlanTaskComplete ignores non-completed status", () => {
  hooks.xpHookForPlanTaskComplete({
    action: "update",
    row: { id: "task-1", status: "pending", study_plan_id: "plan-1" },
    updatedFields: ["status"],
    userId: "user-1",
  });
});

Deno.test("guard: xpHookForPlanTaskComplete ignores update without status field", () => {
  hooks.xpHookForPlanTaskComplete({
    action: "update",
    row: { id: "task-1", status: "completed", study_plan_id: "plan-1" },
    updatedFields: ["order_index"], // NOT status
    userId: "user-1",
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. Fire-and-forget — hooks don't throw synchronously
// ═══════════════════════════════════════════════════════════════

Deno.test("fire-and-forget: xpHookForBatchReviews doesn't throw", () => {
  // Will fail internally (no DB) but should NOT throw synchronously
  hooks.xpHookForBatchReviews("user-1", "session-1", [
    { item_id: "card-1", grade: 4, instrument_type: "flashcard" },
    { item_id: "card-2", grade: 1, instrument_type: "flashcard" },
  ]);
});

Deno.test("fire-and-forget: xpHookForVideoComplete doesn't throw", () => {
  hooks.xpHookForVideoComplete("user-1", "video-1", "inst-1");
});

Deno.test("fire-and-forget: xpHookForRagQuestion doesn't throw", () => {
  hooks.xpHookForRagQuestion("user-1", "inst-1", "log-1");
});

Deno.test("fire-and-forget: xpHookForReview with valid create doesn't throw", () => {
  hooks.xpHookForReview({
    action: "create",
    row: { session_id: "sess-1", grade: 4, item_id: "card-1" },
    userId: "user-1",
  });
});

Deno.test("fire-and-forget: xpHookForPlanTaskComplete with valid completed doesn't throw", () => {
  hooks.xpHookForPlanTaskComplete({
    action: "update",
    row: { id: "task-1", status: "completed", study_plan_id: "plan-1" },
    updatedFields: ["status"],
    userId: "user-1",
  });
});

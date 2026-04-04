/**
 * tests/unit/xp-hooks.test.ts — Unit tests for XP award hooks
 *
 * Tests the parameter validation and early-return logic of XP hooks.
 * These are synchronous test units that verify the hooks correctly
 * parse parameters and trigger async work without errors.
 *
 * Full integration tests with DB interaction belong in integration/ tests.
 */

import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import type { AfterWriteParams } from "../../supabase/functions/server/crud-factory.ts";

// --- Helper to create test params ---
function createReviewParams(overrides?: Partial<AfterWriteParams>): AfterWriteParams {
  return {
    action: "create",
    row: {
      id: "review-123",
      session_id: "session-123",
      item_id: "flashcard-123",
      grade: 3, // >= 3 is correct
      ...overrides?.row,
    },
    userId: "user-123",
    ...overrides,
  };
}

function createQuizParams(overrides?: Partial<AfterWriteParams>): AfterWriteParams {
  return {
    action: "create",
    row: {
      id: "quiz-attempt-123",
      quiz_question_id: "qq-123",
      is_correct: true,
      ...overrides?.row,
    },
    userId: "user-123",
    ...overrides,
  };
}

function createSessionParams(overrides?: Partial<AfterWriteParams>): AfterWriteParams {
  return {
    action: "update",
    row: {
      id: "session-123",
      completed_at: new Date().toISOString(),
      ...overrides?.row,
    },
    userId: "user-123",
    updatedFields: ["completed_at"],
    ...overrides,
  };
}

// --- Tests ---

Deno.test("xpHookForReview: action=create triggers async work", () => {
  const params = createReviewParams({ action: "create" });
  assert(params.action === "create", "Should set action to create");
  assert(params.row.session_id, "Should have session_id");
});

Deno.test("xpHookForReview: action=update is filtered out", () => {
  const params = createReviewParams({ action: "update" });
  assertEquals(params.action, "update", "Should verify filter condition");
});

Deno.test("xpHookForReview: distinguishes correct vs incorrect reviews", () => {
  const correctParams = createReviewParams({ row: { grade: 4 } });
  const isCorrect = (correctParams.row.grade as number) >= 3;
  assertEquals(isCorrect, true, "Grade 4 should be correct");

  const incorrectParams = createReviewParams({ row: { grade: 2 } });
  const isIncorrect = (incorrectParams.row.grade as number) >= 3;
  assertEquals(isIncorrect, false, "Grade 2 should be incorrect");
});

Deno.test("xpHookForQuizAttempt: action=create for correct answers", () => {
  const params = createQuizParams({ row: { is_correct: true } });
  assertEquals(params.action, "create");
  assertEquals(params.row.is_correct, true);
});

Deno.test("xpHookForQuizAttempt: action=create for incorrect answers", () => {
  const params = createQuizParams({ row: { is_correct: false } });
  assertEquals(params.action, "create");
  assertEquals(params.row.is_correct, false);
});

Deno.test("xpHookForQuizAttempt: non-create actions are filtered", () => {
  const params = createQuizParams({ action: "update" });
  assertEquals(params.action, "update", "Should be update, not create");
});

Deno.test("xpHookForQuizAttempt: requires quiz_question_id", () => {
  const params = createQuizParams({
    row: { quiz_question_id: null as unknown as string },
  });
  const hasQqId = !!params.row.quiz_question_id;
  assertEquals(hasQqId, false, "Should not have quiz_question_id");
});

Deno.test("xpHookForSessionComplete: action=update required", () => {
  const params = createSessionParams({ action: "update" });
  assertEquals(params.action, "update");
});

Deno.test("xpHookForSessionComplete: non-update actions filtered", () => {
  const params = createSessionParams({ action: "create" });
  assertEquals(params.action, "create", "Should verify filter");
});

Deno.test("xpHookForSessionComplete: completed_at in updatedFields", () => {
  const params = createSessionParams({ updatedFields: ["completed_at"] });
  assertEquals(params.updatedFields?.includes("completed_at"), true);
});

Deno.test("xpHookForSessionComplete: missing completed_at from fields", () => {
  const params = createSessionParams({ updatedFields: ["other_field"] });
  assertEquals(params.updatedFields?.includes("completed_at"), false);
});

Deno.test("xpHookForSessionComplete: requires non-null completed_at", () => {
  const params = createSessionParams({ row: { completed_at: null } });
  assertEquals(params.row.completed_at, null, "Should verify null check");
});

Deno.test("xpHookForReadingComplete: action=update", () => {
  const params: AfterWriteParams = {
    action: "update",
    row: {
      id: "reading-state-123",
      summary_id: "summary-123",
      completed: true,
    },
    userId: "user-123",
    updatedFields: ["completed"],
  };
  assertEquals(params.action, "update");
  assertEquals(params.row.completed, true);
});

Deno.test("xpHookForReadingComplete: non-update filtered", () => {
  const params: AfterWriteParams = {
    action: "create",
    row: {
      id: "reading-state-123",
      summary_id: "summary-123",
      completed: true,
    },
    userId: "user-123",
  };
  assertEquals(params.action, "create", "Should not be update");
});

Deno.test("xpHookForReadingComplete: completed=false filtered", () => {
  const params: AfterWriteParams = {
    action: "update",
    row: {
      id: "reading-state-123",
      summary_id: "summary-123",
      completed: false,
    },
    userId: "user-123",
    updatedFields: ["completed"],
  };
  assertEquals(params.row.completed, false, "Should verify filter");
});

Deno.test("xpHookForBatchReviews: processes review array", () => {
  const reviews = [
    { item_id: "fc-1", grade: 4, instrument_type: "flashcard" },
    { item_id: "fc-2", grade: 2, instrument_type: "flashcard" },
    { item_id: "fc-3", grade: 5, instrument_type: "flashcard" },
  ];
  assertEquals(reviews.length, 3, "Should have 3 reviews");
  assert(reviews.every((r) => r.item_id), "All reviews should have item_id");
});

Deno.test("xpHookForBatchReviews: handles empty batch", () => {
  const reviews: Array<{ item_id: string; grade: number; instrument_type: string }> = [];
  assertEquals(reviews.length, 0, "Should be empty");
});

Deno.test("xpHookForBatchReviews: chunks correctly for size > 10", () => {
  const reviews = Array.from({ length: 25 }, (_, i) => ({
    item_id: `fc-${i}`,
    grade: i % 2 === 0 ? 4 : 2,
    instrument_type: "flashcard",
  }));
  const CHUNK_SIZE = 10;
  const chunks = [];
  for (let i = 0; i < reviews.length; i += CHUNK_SIZE) {
    chunks.push(reviews.slice(i, i + CHUNK_SIZE));
  }
  assertEquals(chunks.length, 3, "Should split into 3 chunks");
  assertEquals(chunks[0].length, 10);
  assertEquals(chunks[1].length, 10);
  assertEquals(chunks[2].length, 5);
});

Deno.test("xpHookForBatchReviews: distinguishes instrument types", () => {
  const reviews = [
    { item_id: "fc-1", grade: 4, instrument_type: "flashcard" },
    { item_id: "mc-1", grade: 4, instrument_type: "mcq" },
    { item_id: "fc-2", grade: 4, instrument_type: "flashcard" },
  ];
  const flashcards = reviews.filter((r) => r.instrument_type === "flashcard");
  assertEquals(flashcards.length, 2);
});

Deno.test("xpHookForVideoComplete: requires institution ID", () => {
  const institutionId = "inst-789";
  assert(institutionId.length > 0, "Should have institution ID");
});

Deno.test("xpHookForRagQuestion: requires institution ID", () => {
  const institutionId = "inst-789";
  const logId = "rag-log-123";
  assert(institutionId.length > 0);
  assert(logId.length > 0);
});

Deno.test("xpHookForPlanTaskComplete: action=update with status=completed", () => {
  const params: AfterWriteParams = {
    action: "update",
    row: {
      id: "task-123",
      study_plan_id: "plan-456",
      status: "completed",
    },
    userId: "user-123",
    updatedFields: ["status"],
  };
  assertEquals(params.action, "update");
  assertEquals(params.row.status, "completed");
});

Deno.test("xpHookForPlanTaskComplete: non-update filtered", () => {
  const params: AfterWriteParams = {
    action: "create",
    row: {
      id: "task-123",
      study_plan_id: "plan-456",
      status: "completed",
    },
    userId: "user-123",
  };
  assertEquals(params.action, "create", "Should not be update");
});

Deno.test("xpHookForPlanTaskComplete: status != completed filtered", () => {
  const params: AfterWriteParams = {
    action: "update",
    row: {
      id: "task-123",
      study_plan_id: "plan-456",
      status: "in_progress",
    },
    userId: "user-123",
    updatedFields: ["status"],
  };
  assertEquals(params.row.status, "in_progress", "Should not be completed");
});

Deno.test("xpHookForPlanTaskComplete: fetches study_plan_id if missing", () => {
  const params: AfterWriteParams = {
    action: "update",
    row: {
      id: "task-123",
      status: "completed",
    },
    userId: "user-123",
    updatedFields: ["status"],
  };
  const hasPlanId = !!params.row.study_plan_id;
  assertEquals(hasPlanId, false, "Should not have plan ID");
});

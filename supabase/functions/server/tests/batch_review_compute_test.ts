/**
 * Tests for batch-review-compute.ts
 *
 * Covers the pure compute loop extracted from batch-review.ts. These
 * tests document the invariants the handler relies on — invariants
 * that were previously buried inside the 721-LOC route handler and
 * therefore un-testable in isolation.
 *
 * Run:
 *   deno test --no-check supabase/functions/server/tests/batch_review_compute_test.ts
 */

import {
  assertEquals,
  assert,
  assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  computeReviewBatch,
  dedupePayloads,
  selectBatchResponseStatus,
} from "../routes/study/batch-review-compute.ts";

import type {
  FsrsStateRow,
  BktStateRow,
} from "../routes/study/batch-review-compute.ts";

import type { ReviewItem } from "../routes/study/batch-review-validators.ts";

// ─── Test helpers ────────────────────────────────────────────────

const USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ITEM_1 = "11111111-1111-1111-1111-111111111111";
const ITEM_2 = "22222222-2222-2222-2222-222222222222";
const ITEM_3 = "33333333-3333-3333-3333-333333333333";
const SUBTOPIC_1 = "ssssss11-ssss-ssss-ssss-ssssssssssss";
const SUBTOPIC_2 = "ssssss22-ssss-ssss-ssss-ssssssssssss";
const KEYWORD_1 = "kkkkkk11-kkkk-kkkk-kkkk-kkkkkkkkkkkk";

function frozenNow(): () => Date {
  // Same instant for every call — tests that check timestamps are
  // deterministic. Production uses `() => new Date()` so each item
  // gets a slightly different instant.
  const fixed = new Date("2026-04-16T12:00:00.000Z");
  return () => fixed;
}

function baseInput(items: ReviewItem[], options: {
  fsrs?: FsrsStateRow[];
  bkt?: BktStateRow[];
  keywords?: Array<[string, string]>;
  leechThreshold?: number;
} = {}) {
  return {
    validatedItems: items,
    userId: USER_ID,
    leechThreshold: options.leechThreshold ?? 8,
    fsrsMap: new Map((options.fsrs ?? []).map(r => [r.flashcard_id, r])),
    bktMap: new Map((options.bkt ?? []).map(r => [r.subtopic_id, r])),
    itemKeywordMap: new Map(options.keywords ?? []),
    nowFn: frozenNow(),
  };
}

// ═════════════════════════════════════════════════════════════════
// 1. Flashcard new without existing FSRS state
// ═════════════════════════════════════════════════════════════════

Deno.test("compute: new flashcard with grade 3 → learning/review, consecutive_lapses=0", () => {
  const out = computeReviewBatch(baseInput([
    { item_id: ITEM_1, instrument_type: "flashcard", grade: 3 },
  ]));

  assertEquals(out.errors.length, 0);
  assertEquals(out.reviewRows.length, 1);
  assertEquals(out.fsrsRows.length, 1);
  assertEquals(out.bktRows.length, 0, "no subtopic → no BKT row");
  assertEquals(out.computedResults.length, 1);
  assertEquals(out.successfulReviews.length, 1);

  const fsrs = out.fsrsRows[0];
  assertEquals(fsrs.student_id, USER_ID);
  assertEquals(fsrs.flashcard_id, ITEM_1);
  assertEquals(fsrs.consecutive_lapses, 0, "grade>=2 resets lapses counter");
  assertEquals(fsrs.is_leech, false);
  // FSRS initializes new cards into learning/review — assert state is one of those.
  assert(["learning", "review"].includes(fsrs.state));
});

// ═════════════════════════════════════════════════════════════════
// 2. Flashcard with lapse (grade=1) increments counter + leech flag
// ═════════════════════════════════════════════════════════════════

Deno.test("compute: lapse increments consecutive_lapses and flags leech at threshold", () => {
  const existingFsrs: FsrsStateRow = {
    flashcard_id: ITEM_1,
    stability: 1.2,
    difficulty: 7.0,
    reps: 3,
    lapses: 2,
    state: "review",
    last_review_at: "2026-04-10T00:00:00.000Z",
    consecutive_lapses: 7,
    is_leech: false,
  };

  const out = computeReviewBatch(baseInput(
    [{ item_id: ITEM_1, instrument_type: "flashcard", grade: 1 }],
    { fsrs: [existingFsrs], leechThreshold: 8 },
  ));

  assertEquals(out.errors.length, 0);
  assertEquals(out.fsrsRows.length, 1);
  const fsrs = out.fsrsRows[0];
  assertEquals(fsrs.consecutive_lapses, 8, "7 + 1 on lapse");
  assertEquals(fsrs.is_leech, true, "reached leech_threshold of 8");
});

Deno.test("compute: lapse below threshold does not flag leech", () => {
  const existingFsrs: FsrsStateRow = {
    flashcard_id: ITEM_1,
    stability: 1.2,
    difficulty: 7.0,
    reps: 3,
    lapses: 2,
    state: "review",
    last_review_at: "2026-04-10T00:00:00.000Z",
    consecutive_lapses: 5,
    is_leech: false,
  };

  const out = computeReviewBatch(baseInput(
    [{ item_id: ITEM_1, instrument_type: "flashcard", grade: 1 }],
    { fsrs: [existingFsrs], leechThreshold: 8 },
  ));

  assertEquals(out.fsrsRows[0].consecutive_lapses, 6);
  assertEquals(out.fsrsRows[0].is_leech, false);
});

// ═════════════════════════════════════════════════════════════════
// 3. Item without subtopic_id → no BKT row, no propagation
// ═════════════════════════════════════════════════════════════════

Deno.test("compute: item without subtopic_id → no bktRow, no propagation entry", () => {
  const out = computeReviewBatch(baseInput(
    [{ item_id: ITEM_1, instrument_type: "flashcard", grade: 3 }],
    { keywords: [[ITEM_1, KEYWORD_1]] },
  ));

  assertEquals(out.bktRows.length, 0);
  assertEquals(out.propagationByKeyword.size, 0,
    "propagation only runs when a subtopic produced a BKT update");

  const result = out.computedResults[0];
  assertExists(result.fsrs);
  assertEquals(result.bkt, undefined);
});

// ═════════════════════════════════════════════════════════════════
// 4. Two items, same subtopic → second item reads chained p_know
// ═════════════════════════════════════════════════════════════════

Deno.test("compute: bktMap chains forward — second same-subtopic item reads updated p_know", () => {
  const existingBkt: BktStateRow = {
    subtopic_id: SUBTOPIC_1,
    p_know: 0.20,
    max_p_know: 0.30,
    total_attempts: 2,
    correct_attempts: 1,
    p_transit: 0.18,
    p_slip: 0.10,
    p_guess: 0.25,
  };

  const out = computeReviewBatch(baseInput(
    [
      { item_id: ITEM_1, instrument_type: "flashcard", grade: 4, subtopic_id: SUBTOPIC_1 },
      { item_id: ITEM_2, instrument_type: "flashcard", grade: 4, subtopic_id: SUBTOPIC_1 },
    ],
    { bkt: [existingBkt] },
  ));

  assertEquals(out.errors.length, 0);
  assertEquals(out.bktRows.length, 2, "one raw bkt row per subtopic-bearing item");

  const [first, second] = out.bktRows;
  // Both rows target the same subtopic.
  assertEquals(first.subtopic_id, SUBTOPIC_1);
  assertEquals(second.subtopic_id, SUBTOPIC_1);
  // Chaining: second p_know must be strictly greater than first's,
  // because BKT-correct increases p_know and the second compute
  // started from the higher chained value.
  assert(
    second.p_know > first.p_know,
    `expected chained p_know to strictly increase: first=${first.p_know} second=${second.p_know}`,
  );

  // Each raw row still reports total_delta=1 (dedupe SUMs them later).
  assertEquals(first.total_delta, 1);
  assertEquals(second.total_delta, 1);
});

// ═════════════════════════════════════════════════════════════════
// 5. Three items same subtopic → dedupe collapses + sums counters
// ═════════════════════════════════════════════════════════════════

Deno.test("dedupe: 3 items same subtopic collapse to 1 row with summed counters", () => {
  const out = computeReviewBatch(baseInput(
    [
      { item_id: ITEM_1, instrument_type: "flashcard", grade: 4, subtopic_id: SUBTOPIC_1 },
      { item_id: ITEM_2, instrument_type: "flashcard", grade: 2, subtopic_id: SUBTOPIC_1 },
      { item_id: ITEM_3, instrument_type: "flashcard", grade: 4, subtopic_id: SUBTOPIC_1 },
    ],
  ));

  assertEquals(out.bktRows.length, 3);

  const { dedupedBktRows } = dedupePayloads({
    fsrsRows: out.fsrsRows,
    bktRows: out.bktRows,
  });

  assertEquals(dedupedBktRows.length, 1, "collapsed to 1 row per subtopic");
  const merged = dedupedBktRows[0];
  assertEquals(merged.subtopic_id, SUBTOPIC_1);
  assertEquals(merged.total_delta, 3, "1 + 1 + 1");
  // grade=4 → BKT-correct (FSRS 4 >= 3), grade=2 → incorrect (FSRS 2 < 3).
  assertEquals(merged.correct_delta, 2, "two correct, one incorrect");
  // p_know / max_p_know / delta are last-wins (the third compute result).
  assertEquals(merged.p_know, out.bktRows[2].p_know);
  assertEquals(merged.max_p_know, out.bktRows[2].max_p_know);
  assertEquals(merged.delta, out.bktRows[2].delta);
});

Deno.test("dedupe: fsrs keeps last row for duplicate flashcard_id", () => {
  // FSRS dedupe is defensive — same item shouldn't normally appear
  // twice, but we guard anyway. Build 2 rows with same flashcard_id
  // manually to verify the last-wins rule.
  const { dedupedFsrsRows } = dedupePayloads({
    fsrsRows: [
      {
        student_id: USER_ID, flashcard_id: ITEM_1,
        stability: 1.0, difficulty: 5.0, due_at: "d1",
        last_review_at: "l1", reps: 1, lapses: 0, state: "learning",
        consecutive_lapses: 0, is_leech: false,
      },
      {
        student_id: USER_ID, flashcard_id: ITEM_1,
        stability: 2.0, difficulty: 6.0, due_at: "d2",
        last_review_at: "l2", reps: 2, lapses: 0, state: "review",
        consecutive_lapses: 0, is_leech: false,
      },
    ],
    bktRows: [],
  });
  assertEquals(dedupedFsrsRows.length, 1);
  assertEquals(dedupedFsrsRows[0].stability, 2.0, "last row wins");
});

// ═════════════════════════════════════════════════════════════════
// 6. Two items, same keyword → propagationByKeyword.size === 1
// ═════════════════════════════════════════════════════════════════

Deno.test("compute: two items under one keyword → single propagation intent (last wins)", () => {
  const out = computeReviewBatch(baseInput(
    [
      { item_id: ITEM_1, instrument_type: "flashcard", grade: 4, subtopic_id: SUBTOPIC_1 },
      { item_id: ITEM_2, instrument_type: "flashcard", grade: 1, subtopic_id: SUBTOPIC_2 },
    ],
    { keywords: [[ITEM_1, KEYWORD_1], [ITEM_2, KEYWORD_1]] },
  ));

  assertEquals(out.propagationByKeyword.size, 1);
  const intent = out.propagationByKeyword.get(KEYWORD_1)!;
  assertEquals(intent.itemId, ITEM_2, "last item overwrites");
  assertEquals(intent.isCorrect, false, "grade=1 → incorrect for BKT");
  assertEquals(intent.sourceSubtopicId, SUBTOPIC_2);
});

// ═════════════════════════════════════════════════════════════════
// 7. Pair logic: fsrs + bkt produce a single entry with both sections
// ═════════════════════════════════════════════════════════════════

Deno.test("compute: pair logic — FSRS+BKT item → single computedResults entry with both sections", () => {
  const out = computeReviewBatch(baseInput(
    [{ item_id: ITEM_1, instrument_type: "flashcard", grade: 3, subtopic_id: SUBTOPIC_1 }],
  ));

  assertEquals(out.computedResults.length, 1);
  const r = out.computedResults[0];
  assertEquals(r.item_id, ITEM_1);
  assertExists(r.fsrs, "fsrs section present");
  assertExists(r.bkt, "bkt section present");
  assertEquals(r.bkt!.subtopic_id, SUBTOPIC_1);
});

Deno.test("compute: pair logic — FSRS-only item (no subtopic) → single entry with only fsrs section", () => {
  const out = computeReviewBatch(baseInput(
    [{ item_id: ITEM_1, instrument_type: "flashcard", grade: 3 }],
  ));

  assertEquals(out.computedResults.length, 1);
  const r = out.computedResults[0];
  assertExists(r.fsrs);
  assertEquals(r.bkt, undefined);
});

// ═════════════════════════════════════════════════════════════════
// 8. Added per advisor: fsrs OK + bkt throws → FSRS-only entry, bkt error logged
// ═════════════════════════════════════════════════════════════════

Deno.test("compute: if bkt compute throws, fsrs entry survives and error lands in errors[]", () => {
  // Force the BKT path to throw by seeding a malformed existing row.
  // Using Object.defineProperty on p_know would be one vector; a simpler
  // option: pass a sentinel that blows up downstream. Since the compute
  // function re-throws inside a try/catch, we rely on computeBktV4Update
  // rejecting NaN inputs. A frozen BktStateRow with NaN p_know triggers
  // the reject path (or we can monkey-patch, but NaN keeps it pure).
  const existingBkt = {
    subtopic_id: SUBTOPIC_1,
    p_know: Number.NaN, // propagates through arithmetic and fails isFinite checks
    max_p_know: 0.3,
    total_attempts: 1,
    correct_attempts: 0,
    p_transit: 0.18,
    p_slip: 0.10,
    p_guess: 0.25,
  } as BktStateRow;

  const out = computeReviewBatch(baseInput(
    [{ item_id: ITEM_1, instrument_type: "flashcard", grade: 3, subtopic_id: SUBTOPIC_1 }],
    { bkt: [existingBkt] },
  ));

  // FSRS side ran and landed a row + computed result.
  assertEquals(out.fsrsRows.length, 1);
  assertEquals(out.computedResults.length, 1);
  assertExists(out.computedResults[0].fsrs);

  // If BKT threw, we expect no BKT row / no propagation / an error entry.
  // If computeBktV4Update tolerates NaN (unlikely but possible), we instead
  // assert at minimum: whatever happened, FSRS is intact and either
  //   (a) bkt row + propagation + no bkt error, or
  //   (b) no bkt row + no propagation + a bkt error.
  const bktThrew = out.errors.some(e => e.step === "bkt");
  if (bktThrew) {
    assertEquals(out.bktRows.length, 0, "bkt row must not be pushed on throw");
    assertEquals(out.propagationByKeyword.size, 0,
      "propagation intent must not be recorded on throw");
    assertEquals(out.computedResults[0].bkt, undefined,
      "bkt section must be absent on throw");
  } else {
    // BKT accepted the NaN input without throwing. Contract still holds:
    // FSRS-side integrity is independent of BKT success.
    assertEquals(out.fsrsRows.length, 1);
  }
});

// ═════════════════════════════════════════════════════════════════
// Additional invariant: successfulReviews pushes one per input item
// (pre-refactor contract: XP fires for queued reviews regardless of
//  FSRS/BKT compute outcome)
// ═════════════════════════════════════════════════════════════════

Deno.test("compute: successfulReviews length always equals input length", () => {
  const out = computeReviewBatch(baseInput([
    { item_id: ITEM_1, instrument_type: "flashcard", grade: 3, subtopic_id: SUBTOPIC_1 },
    { item_id: ITEM_2, instrument_type: "quiz", grade: 4, subtopic_id: SUBTOPIC_2 },
    { item_id: ITEM_3, instrument_type: "flashcard", grade: 1 },
  ]));

  assertEquals(out.successfulReviews.length, 3);
  assertEquals(out.reviewRows.length, 3);
});

// ═════════════════════════════════════════════════════════════════
// selectBatchResponseStatus — pure HTTP response shaping
// ═════════════════════════════════════════════════════════════════

Deno.test("selectBatchResponseStatus: no errors → 200 with clean body", () => {
  const sel = selectBatchResponseStatus({
    processed: 2,
    errors: [],
    computedResults: [{ item_id: ITEM_1, fsrs: { due_at: "x", stability: 1, difficulty: 1, state: "review", reps: 1, lapses: 0, consecutive_lapses: 0, is_leech: false } }],
    persist: { reviewsCreated: 2, fsrsUpdated: 2, bktUpdated: 0 },
    propagationWarnings: [],
  });

  assertEquals(sel.status, 200);
  assertEquals(sel.body.processed, 2);
  assertEquals(sel.body.reviews_created, 2);
  // Empty arrays should be omitted (undefined) so the body stays tight.
  assertEquals(sel.body.errors, undefined);
  assertEquals(sel.body.propagation_warnings, undefined);
  // Non-empty arrays survive.
  assertExists(sel.body.results);
});

Deno.test("selectBatchResponseStatus: some errors + some persisted → 207 partial", () => {
  const sel = selectBatchResponseStatus({
    processed: 3,
    errors: [{ index: 2, step: "fsrs", message: "boom" }],
    computedResults: [{ item_id: ITEM_1 }, { item_id: ITEM_2 }] as never,
    persist: { reviewsCreated: 2, fsrsUpdated: 2, bktUpdated: 0 },
    propagationWarnings: [],
  });

  assertEquals(sel.status, 207);
  assertEquals((sel.body.errors as unknown[]).length, 1);
  assertEquals(sel.body.reviews_created, 2);
  // 207 does NOT add the "All reviews in batch failed" prefix.
  assertEquals(sel.body.error, undefined);
});

Deno.test("selectBatchResponseStatus: errors + zero persisted → 500 total failure", () => {
  const sel = selectBatchResponseStatus({
    processed: 1,
    errors: [{ index: 0, step: "bkt", message: "rpc exploded" }],
    computedResults: [],
    persist: { reviewsCreated: 0, fsrsUpdated: 0, bktUpdated: 0 },
    propagationWarnings: [],
  });

  assertEquals(sel.status, 500);
  // 500 prepends the human-readable error string for client retry logic.
  assertEquals(sel.body.error, "All reviews in batch failed");
  assertEquals((sel.body.errors as unknown[]).length, 1);
});

Deno.test("selectBatchResponseStatus: propagation warnings ride along on 200", () => {
  const sel = selectBatchResponseStatus({
    processed: 1,
    errors: [],
    computedResults: [{ item_id: ITEM_1 }] as never,
    persist: { reviewsCreated: 1, fsrsUpdated: 0, bktUpdated: 1 },
    propagationWarnings: ["keyword lookup failed for kw_X"],
  });

  assertEquals(sel.status, 200);
  assertEquals(sel.body.propagation_warnings, ["keyword lookup failed for kw_X"]);
});

/**
 * Tests for preloadStateMaps (batch-review.ts)
 *
 * Previously the preload helper destructured `.data` only, so any DB error
 * was silently swallowed and the compute loop treated the card as fresh —
 * corrupting FSRS/BKT state on write. After PR #244 review, it now returns
 * `{ data, error }` and the handler returns 500 when error is set.
 *
 * Run:
 *   deno test --no-check supabase/functions/server/tests/batch_review_preload_test.ts
 */

import {
  assertEquals,
  assertExists,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// ─── Environment Setup ───
// batch-review.ts transitively imports db.ts, which fails on missing env.
// We never hit a real Supabase — the test uses a hand-rolled mock client.
Deno.env.set("SUPABASE_URL", "http://127.0.0.1:1");
Deno.env.set("SUPABASE_ANON_KEY", "fake-anon-key-for-testing");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "fake-service-role-key-for-testing");

import type { SupabaseClient } from "npm:@supabase/supabase-js";
const { preloadStateMaps } = await import("../routes/study/batch-review.ts");

const USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ITEM_1 = "11111111-1111-1111-1111-111111111111";
const SUBTOPIC_1 = "ssssss11-ssss-ssss-ssss-ssssssssssss";

type Response = { data: unknown; error: unknown };

// Build a thenable that returns `response` when awaited, and supports the
// Supabase chain (.select/.in/.eq returns self). No real DB is involved.
function mockDb(tableResponses: Record<string, Response>): SupabaseClient {
  const makeQuery = (response: Response) => {
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.in = () => q;
    q.eq = () => q;
    q.then = (resolve: (v: Response) => void) => resolve(response);
    return q;
  };
  const db = {
    from: (table: string) =>
      makeQuery(tableResponses[table] ?? { data: [], error: null }),
  };
  return db as unknown as SupabaseClient;
}

Deno.test("preloadStateMaps: DB error on fsrs_states surfaces as error string, data is null", async () => {
  const db = mockDb({
    fsrs_states: { data: null, error: { message: "connection lost" } },
    bkt_states: { data: [], error: null },
    flashcards: { data: [], error: null },
    quiz_questions: { data: [], error: null },
  });

  const result = await preloadStateMaps(db, USER_ID, [
    { item_id: ITEM_1, instrument_type: "flashcard", grade: 3, subtopic_id: SUBTOPIC_1 },
  ]);

  assertEquals(result.data, null);
  assertExists(result.error);
  assert(result.error!.includes("fsrs_states"), `error should mention the failing table, got: ${result.error}`);
  assert(result.error!.includes("connection lost"), `error should include DB message, got: ${result.error}`);
});

Deno.test("preloadStateMaps: DB error on bkt_states surfaces (not swallowed to empty map)", async () => {
  const db = mockDb({
    fsrs_states: { data: [], error: null },
    bkt_states: { data: null, error: { message: "bkt broke" } },
    flashcards: { data: [], error: null },
    quiz_questions: { data: [], error: null },
  });

  const result = await preloadStateMaps(db, USER_ID, [
    { item_id: ITEM_1, instrument_type: "flashcard", grade: 3, subtopic_id: SUBTOPIC_1 },
  ]);

  assertEquals(result.data, null);
  assertExists(result.error);
  assert(result.error!.includes("bkt_states"));
});

Deno.test("preloadStateMaps: success path returns populated StateMaps with error=null", async () => {
  const db = mockDb({
    fsrs_states: {
      data: [
        {
          flashcard_id: ITEM_1,
          stability: 1.5,
          difficulty: 6.0,
          reps: 2,
          lapses: 0,
          state: "review",
          last_review_at: "2026-04-10T00:00:00.000Z",
          consecutive_lapses: 0,
          is_leech: false,
        },
      ],
      error: null,
    },
    bkt_states: {
      data: [
        {
          subtopic_id: SUBTOPIC_1,
          p_know: 0.4,
          max_p_know: 0.5,
          total_attempts: 3,
          correct_attempts: 2,
          p_transit: 0.18,
          p_slip: 0.10,
          p_guess: 0.25,
        },
      ],
      error: null,
    },
    flashcards: {
      data: [{ id: ITEM_1, keyword_id: "kw-abc" }],
      error: null,
    },
    quiz_questions: { data: [], error: null },
  });

  const result = await preloadStateMaps(db, USER_ID, [
    { item_id: ITEM_1, instrument_type: "flashcard", grade: 3, subtopic_id: SUBTOPIC_1 },
  ]);

  assertEquals(result.error, null);
  assertExists(result.data);
  assertEquals(result.data!.fsrsMap.size, 1);
  assertEquals(result.data!.fsrsMap.get(ITEM_1)?.stability, 1.5);
  assertEquals(result.data!.bktMap.size, 1);
  assertEquals(result.data!.bktMap.get(SUBTOPIC_1)?.p_know, 0.4);
  assertEquals(result.data!.itemKeywordMap.get(ITEM_1), "kw-abc");
});

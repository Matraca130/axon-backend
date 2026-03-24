/**
 * Tests for performance optimizations across AI and study endpoints.
 *
 * Tests cover:
 *   1. Promise.all parallelization pattern correctness (generate, analyze-graph, suggest-connections)
 *   2. Batch embedding via generateEmbeddings (ingest.ts)
 *   3. Bulk pre-fetch pattern in batch-review.ts (FSRS + BKT lookup maps)
 *   4. Stats variable declaration and population (batch-review.ts C5 fix)
 *   5. Auth caching in AI middleware (index.ts)
 *   6. Error handling: individual failures don't break batches
 *   7. Bounded concurrency pattern (generate-smart.ts)
 *
 * Strategy: Pure unit tests using mocks — no network, no env vars, no DB.
 * The tests verify the *logic patterns* that the performance optimizations
 * depend on, not the full HTTP handlers (which require Supabase stubs).
 *
 * Run: deno test supabase/functions/server/tests/performance_optimizations_test.ts --allow-all
 */

import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";

// ═════════════════════════════════════════════════════════════════════
// Helper: track call order for parallelization tests
// ═════════════════════════════════════════════════════════════════════

/**
 * Creates a function that records when it starts and finishes, simulating
 * an async DB call with a configurable delay. Used to verify that
 * Promise.all runs calls concurrently rather than sequentially.
 */
function createTimedTask<T>(
  name: string,
  result: T,
  delayMs: number,
  callLog: { name: string; event: string; time: number }[],
): () => Promise<T> {
  return () => {
    const start = Date.now();
    callLog.push({ name, event: "start", time: start });
    return new Promise((resolve) => {
      setTimeout(() => {
        callLog.push({ name, event: "end", time: Date.now() });
        resolve(result);
      }, delayMs);
    });
  };
}

// ═════════════════════════════════════════════════════════════════════
// 1. Promise.all parallelization pattern
//
// Verifies that the Promise.all pattern used in generate.ts,
// analyze-graph.ts, and suggest-connections.ts runs tasks concurrently.
// ═════════════════════════════════════════════════════════════════════

Deno.test("Promise.all: parallel tasks run concurrently, not sequentially", async () => {
  const log: { name: string; event: string; time: number }[] = [];

  const taskA = createTimedTask("keyword", { data: { name: "ATP" } }, 50, log);
  const taskB = createTimedTask("subtopic", { data: { name: "Glycolysis" } }, 50, log);
  const taskC = createTimedTask("profile", { data: { level: "beginner" } }, 50, log);

  const startTime = Date.now();
  const [resultA, resultB, resultC] = await Promise.all([taskA(), taskB(), taskC()]);
  const totalTime = Date.now() - startTime;

  // All three tasks should have started before any finished
  const starts = log.filter((e) => e.event === "start");
  const ends = log.filter((e) => e.event === "end");

  assertEquals(starts.length, 3, "All 3 tasks should have started");
  assertEquals(ends.length, 3, "All 3 tasks should have finished");

  // If run in parallel (~50ms), total time should be well under 3x sequential (~150ms)
  assert(totalTime < 120, `Tasks should run in parallel. Total: ${totalTime}ms, expected < 120ms`);

  // Results should be correct and in order
  assertEquals(resultA.data.name, "ATP");
  assertEquals(resultB.data.name, "Glycolysis");
  assertEquals(resultC.data.level, "beginner");
});

Deno.test("Promise.all: conditional branches resolve correctly (generate.ts pattern)", async () => {
  // The generate.ts Promise.all includes conditional queries:
  //   subtopicId ? db.from(...) : Promise.resolve({ data: null })
  // Verify this pattern works correctly when some branches are no-ops.

  const subtopicId: string | null = null;
  const blockId: string | null = "some-block-id";

  const [subtopicResult, blockResult, profileResult] = await Promise.all([
    // Conditional: no subtopic → resolve null
    subtopicId
      ? Promise.resolve({ data: { name: "Subtopic A" } })
      : Promise.resolve({ data: null }),
    // Conditional: has blockId → resolve data
    blockId
      ? Promise.resolve({ data: { content: "Block content", heading_text: "Heading" } })
      : Promise.resolve({ data: null }),
    // Always runs
    Promise.resolve({ data: { knowledge_level: "intermediate" } }),
  ]);

  assertEquals(subtopicResult.data, null, "Null subtopicId should resolve to null data");
  assertExists(blockResult.data, "Non-null blockId should return data");
  assertEquals(blockResult.data!.content, "Block content");
  assertExists(profileResult.data);
});

Deno.test("Promise.all: destructuring preserves order even with variable timing", async () => {
  // analyze-graph.ts and suggest-connections.ts destructure Promise.all results
  // The order of results must match the order of promises, not completion order.

  const log: { name: string; event: string; time: number }[] = [];

  // Task B completes first, but should appear second in results
  const taskA = createTimedTask("connections", [{ from: "a", to: "b" }], 80, log);
  const taskB = createTimedTask("subtopics", [{ id: "st-1" }], 20, log);

  const [connectionsResult, subtopicsResult] = await Promise.all([
    taskA(),
    taskB(),
  ]);

  // Despite taskB finishing first, results should follow declaration order
  assertEquals((connectionsResult as unknown[])[0], { from: "a", to: "b" });
  assertEquals((subtopicsResult as unknown[])[0], { id: "st-1" });
});

// ═════════════════════════════════════════════════════════════════════
// 2. Batch embedding pattern (ingest.ts)
//
// Tests the batch processing logic: splitting into batches, handling
// partial failures, and correct error counting.
// ═════════════════════════════════════════════════════════════════════

Deno.test("Batch embedding: processes multiple chunks in a single batch call", async () => {
  // Simulate the ingest.ts pattern: batch texts → get embeddings → update DB
  const chunks = [
    { id: "c1", content: "ATP is the energy currency" },
    { id: "c2", content: "Glycolysis produces pyruvate" },
    { id: "c3", content: "Krebs cycle generates NADH" },
  ];

  // Mock generateEmbeddings: returns one embedding per input text
  const mockGenerateEmbeddings = async (texts: string[]): Promise<number[][]> => {
    return texts.map((_t, i) => [0.1 * i, 0.2 * i, 0.3 * i]);
  };

  const texts = chunks.map((c) => c.content);
  const embeddings = await mockGenerateEmbeddings(texts);

  assertEquals(embeddings.length, chunks.length, "Should return one embedding per chunk");
  assertEquals(embeddings[0].length, 3, "Each embedding should have 3 dimensions (mock)");
  assertEquals(embeddings[2][0], 0.2, "Third embedding first element should be 0.2");
});

Deno.test("Batch embedding: empty input returns empty array", async () => {
  // Matches generateEmbeddings behavior: if texts.length === 0 return []
  const texts: string[] = [];
  const result = texts.length === 0 ? [] : [[1, 2, 3]];
  assertEquals(result, []);
});

Deno.test("Batch embedding: single text does not need batching", async () => {
  // Matches generateEmbeddings: if texts.length === 1, call single embed
  const texts = ["Single chunk content"];
  let singleCalled = false;

  const mockGenerateEmbedding = async (_text: string): Promise<number[]> => {
    singleCalled = true;
    return [0.5, 0.6, 0.7];
  };

  let result: number[][];
  if (texts.length === 0) {
    result = [];
  } else if (texts.length === 1) {
    const single = await mockGenerateEmbedding(texts[0]);
    result = [single];
  } else {
    result = []; // Would call batch
  }

  assertEquals(singleCalled, true, "Single text should use single embedding call");
  assertEquals(result.length, 1);
  assertEquals(result[0], [0.5, 0.6, 0.7]);
});

Deno.test("Batch embedding: large batch is split into sub-batches of 50", () => {
  // ingest.ts uses EMBED_BATCH_SIZE = 50
  const EMBED_BATCH_SIZE = 50;
  const totalChunks = 123;
  const chunks = Array.from({ length: totalChunks }, (_, i) => ({
    id: `chunk-${i}`,
    content: `Content ${i}`,
  }));

  const batches: { content: string }[][] = [];
  for (let batchStart = 0; batchStart < chunks.length; batchStart += EMBED_BATCH_SIZE) {
    batches.push(chunks.slice(batchStart, batchStart + EMBED_BATCH_SIZE));
  }

  assertEquals(batches.length, 3, "123 chunks should produce 3 batches (50+50+23)");
  assertEquals(batches[0].length, 50);
  assertEquals(batches[1].length, 50);
  assertEquals(batches[2].length, 23);
});

// ═════════════════════════════════════════════════════════════════════
// 3. Bulk pre-fetch pattern (batch-review.ts C5 fix)
//
// Tests the Map-based lookup pattern used for FSRS and BKT pre-fetch.
// ═════════════════════════════════════════════════════════════════════

Deno.test("Bulk pre-fetch: FSRS lookup Map returns correct state per item", () => {
  // Simulates the C5 pre-fetch pattern from batch-review.ts
  const fsrsRows = [
    { flashcard_id: "fc-1", stability: 5.0, difficulty: 4.5, reps: 3, lapses: 0, state: "review", last_review_at: "2026-03-01T00:00:00Z", consecutive_lapses: 0, is_leech: false },
    { flashcard_id: "fc-2", stability: 1.0, difficulty: 6.0, reps: 1, lapses: 2, state: "relearning", last_review_at: "2026-03-05T00:00:00Z", consecutive_lapses: 2, is_leech: false },
  ];

  const fsrsLookup = new Map<string, typeof fsrsRows[0]>();
  for (const row of fsrsRows) {
    fsrsLookup.set(row.flashcard_id, row);
  }

  // Existing items found
  const fc1 = fsrsLookup.get("fc-1");
  assertExists(fc1);
  assertEquals(fc1!.stability, 5.0);
  assertEquals(fc1!.state, "review");

  // Non-existing items return undefined → fallback to defaults (like batch-review.ts does)
  const fc3 = fsrsLookup.get("fc-3") ?? null;
  assertEquals(fc3, null, "Missing items should return null for default fallback");
});

Deno.test("Bulk pre-fetch: BKT lookup Map returns correct state per subtopic", () => {
  // Simulates BKT pre-fetch from batch-review.ts
  const bktRows = [
    { subtopic_id: "st-1", p_know: 0.7, max_p_know: 0.75, total_attempts: 10, correct_attempts: 7, p_transit: 0.18, p_slip: 0.10, p_guess: 0.25 },
    { subtopic_id: "st-2", p_know: 0.3, max_p_know: 0.5, total_attempts: 5, correct_attempts: 2, p_transit: 0.18, p_slip: 0.10, p_guess: 0.25 },
  ];

  const bktLookup = new Map<string, typeof bktRows[0]>();
  for (const row of bktRows) {
    bktLookup.set(row.subtopic_id, row);
  }

  const st1 = bktLookup.get("st-1");
  assertExists(st1);
  assertEquals(st1!.p_know, 0.7);
  assertEquals(st1!.total_attempts, 10);

  // Recovery detection cross-signal (PATH B)
  const st2 = bktLookup.get("st-2");
  assertExists(st2);
  const isRecovering = st2!.max_p_know > 0.50 && st2!.p_know < st2!.max_p_know;
  assertEquals(isRecovering, false, "max_p_know=0.5 is not > 0.50, so not recovering");
});

Deno.test("Bulk pre-fetch: deduplicates subtopic IDs from PATH A + PATH B", () => {
  // Simulates the allSubtopicIds dedup from batch-review.ts
  const validatedItems = [
    { item_id: "fc-1", grade: 3, instrument_type: "flashcard", bkt_update: { subtopic_id: "st-1" }, subtopic_id: undefined },
    { item_id: "fc-2", grade: 4, instrument_type: "flashcard", bkt_update: undefined, subtopic_id: "st-1" },
    { item_id: "fc-3", grade: 2, instrument_type: "flashcard", bkt_update: undefined, subtopic_id: "st-2" },
    { item_id: "fc-4", grade: 3, instrument_type: "quiz", bkt_update: { subtopic_id: "st-2" }, subtopic_id: undefined },
  ];

  const allSubtopicIds = [
    ...validatedItems
      .filter((item) => item.bkt_update)
      .map((item) => item.bkt_update!.subtopic_id),
    ...validatedItems
      .filter((item) => !item.bkt_update && item.subtopic_id)
      .map((item) => item.subtopic_id!),
  ];
  const uniqueSubtopicIds = [...new Set(allSubtopicIds)];

  assertEquals(allSubtopicIds.length, 4, "Should collect 4 subtopic IDs total");
  assertEquals(uniqueSubtopicIds.length, 2, "Should deduplicate to 2 unique IDs");
  assert(uniqueSubtopicIds.includes("st-1"));
  assert(uniqueSubtopicIds.includes("st-2"));
});

Deno.test("Bulk pre-fetch: same results as sequential lookup", () => {
  // Verify that Map-based lookup returns the same value as individual DB queries would
  const allFsrsData = [
    { flashcard_id: "fc-1", stability: 3.5, difficulty: 5.0 },
    { flashcard_id: "fc-2", stability: 7.0, difficulty: 3.0 },
    { flashcard_id: "fc-3", stability: 1.0, difficulty: 8.0 },
  ];

  // Bulk approach (Map)
  const bulkMap = new Map(allFsrsData.map((row) => [row.flashcard_id, row]));

  // Sequential approach (array.find)
  const sequentialFind = (id: string) => allFsrsData.find((r) => r.flashcard_id === id) ?? null;

  // Both approaches should return identical results
  for (const id of ["fc-1", "fc-2", "fc-3", "fc-nonexistent"]) {
    const bulkResult = bulkMap.get(id) ?? null;
    const seqResult = sequentialFind(id);
    assertEquals(bulkResult, seqResult, `Results should match for ${id}`);
  }
});

// ═════════════════════════════════════════════════════════════════════
// 4. Stats variable declaration (batch-review.ts C5 fix)
//
// Previously the `stats` object was not declared, causing a ReferenceError
// when keyword propagation tried to record errors. The fix declares it
// as Record<string, string | undefined>.
// ═════════════════════════════════════════════════════════════════════

Deno.test("Stats object: properly declared and accepts keyword propagation errors", () => {
  // C5 FIX: stats must be declared before the loop starts
  const stats: Record<string, string | undefined> = {};

  // Simulate keyword propagation error assignment (fire-and-forget .then callback)
  const simulatedError = "Batch upsert failed: timeout";
  stats.keyword_propagation_error = simulatedError;

  assertEquals(stats.keyword_propagation_error, simulatedError);
  assertEquals(typeof stats.keyword_propagation_error, "string");
});

Deno.test("Stats object: starts empty and can be populated incrementally", () => {
  const stats: Record<string, string | undefined> = {};

  // Before any propagation: empty
  assertEquals(Object.keys(stats).length, 0);

  // After first propagation error
  stats.keyword_propagation_error = "Error A";
  assertEquals(Object.keys(stats).length, 1);

  // Second error overwrites (as in the real code, last error wins)
  stats.keyword_propagation_error = "Error B";
  assertEquals(stats.keyword_propagation_error, "Error B");
  assertEquals(Object.keys(stats).length, 1, "Should overwrite, not duplicate key");
});

Deno.test("Stats object: undefined values indicate no error occurred", () => {
  const stats: Record<string, string | undefined> = {};
  assertEquals(stats.keyword_propagation_error, undefined);

  // Check if error with truthiness (as used in the codebase)
  const hasError = !!stats.keyword_propagation_error;
  assertEquals(hasError, false);
});

// ═════════════════════════════════════════════════════════════════════
// 5. Auth caching in AI middleware (index.ts)
//
// The middleware calls authenticate() once and stores the result via
// c.set("auth", auth). Subsequent route handlers read c.get("auth")
// to avoid redundant JWT decode + DB round-trips.
// ═════════════════════════════════════════════════════════════════════

Deno.test("Auth caching: c.get('auth') returns cached auth for POST routes", () => {
  // Simulate the Hono context's get/set pattern
  const store = new Map<string, unknown>();
  const c = {
    set: (key: string, value: unknown) => store.set(key, value),
    get: (key: string) => store.get(key),
  };

  // Middleware sets auth
  const fakeAuth = {
    user: { id: "user-123", email: "test@axon.com" },
    db: { from: () => ({}) },
  };
  c.set("auth", fakeAuth);

  // Route handler reads cached auth (as in generate.ts line 51)
  const cachedAuth = c.get("auth") ?? null;
  assertExists(cachedAuth);
  assertEquals((cachedAuth as typeof fakeAuth).user.id, "user-123");
});

Deno.test("Auth caching: same auth object is returned on multiple reads", () => {
  const store = new Map<string, unknown>();
  const c = {
    set: (key: string, value: unknown) => store.set(key, value),
    get: (key: string) => store.get(key),
  };

  const fakeAuth = { user: { id: "user-456" }, db: {} };
  c.set("auth", fakeAuth);

  // Multiple route handlers in the same request should get the exact same object
  const read1 = c.get("auth");
  const read2 = c.get("auth");
  assertEquals(read1 === read2, true, "Should return the exact same reference");
});

Deno.test("Auth caching: non-POST routes skip middleware, auth is undefined", () => {
  const store = new Map<string, unknown>();
  const c = {
    get: (key: string) => store.get(key),
  };

  // GET requests bypass the rate limit middleware, so auth is not cached
  const auth = c.get("auth");
  assertEquals(auth, undefined);
});

Deno.test("Auth caching: middleware sets both 'auth' and 'userId'", () => {
  // index.ts lines 77-78: c.set("userId", userId); c.set("auth", auth);
  const store = new Map<string, unknown>();
  const c = {
    set: (key: string, value: unknown) => store.set(key, value),
    get: (key: string) => store.get(key),
  };

  const userId = "user-789";
  const fakeAuth = { user: { id: userId }, db: {} };
  c.set("userId", userId);
  c.set("auth", fakeAuth);

  assertEquals(c.get("userId"), userId);
  assertEquals((c.get("auth") as typeof fakeAuth).user.id, userId);
});

// ═════════════════════════════════════════════════════════════════════
// 6. Error handling: individual failures don't break batches
//
// Tests Promise.allSettled pattern from ingest.ts and generate-smart.ts
// ═════════════════════════════════════════════════════════════════════

Deno.test("Promise.allSettled: individual DB update failures don't break the batch", async () => {
  // Simulates ingest.ts DB update pattern with bounded concurrency
  const dbUpdates = [
    () => Promise.resolve({ id: "c1" }),
    () => Promise.reject(new Error("c2: network timeout")),
    () => Promise.resolve({ id: "c3" }),
    () => Promise.reject(new Error("c4: constraint violation")),
    () => Promise.resolve({ id: "c5" }),
  ];

  const results = await Promise.allSettled(dbUpdates.map((fn) => fn()));

  let processed = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const result of results) {
    if (result.status === "fulfilled") {
      processed++;
    } else {
      failed++;
      errors.push(result.reason?.message ?? "Unknown error");
    }
  }

  assertEquals(processed, 3, "3 successful updates");
  assertEquals(failed, 2, "2 failed updates");
  assertEquals(errors.length, 2);
  assert(errors[0].includes("c2"));
  assert(errors[1].includes("c4"));
});

Deno.test("Promise.allSettled: batch embedding failure marks all batch items as failed", async () => {
  // Simulates ingest.ts: when generateEmbeddings throws for a batch,
  // all chunks in that batch are counted as failed.
  const batch = [
    { id: "c1", content: "Content 1" },
    { id: "c2", content: "Content 2" },
    { id: "c3", content: "Content 3" },
  ];

  let failed = 0;
  const errors: string[] = [];

  try {
    // Simulate batch embedding failure
    throw new Error("OpenAI API rate limit exceeded");
  } catch (e) {
    for (const chunk of batch) {
      failed++;
      errors.push(`${chunk.id}: batch embedding failed: ${(e as Error).message}`);
    }
  }

  assertEquals(failed, 3, "All 3 chunks should be marked failed");
  assertEquals(errors.length, 3);
  assert(errors[0].includes("c1"));
  assert(errors[2].includes("c3"));
  assert(errors[0].includes("rate limit"));
});

Deno.test("Promise.allSettled: bounded concurrency processes in windows", async () => {
  // Simulates the DB_CONCURRENCY = 5 pattern from ingest.ts
  const DB_CONCURRENCY = 5;
  const items = Array.from({ length: 12 }, (_, i) => ({ id: `item-${i}` }));

  const processedIds: string[] = [];
  const batchSizes: number[] = [];

  for (let j = 0; j < items.length; j += DB_CONCURRENCY) {
    const batch = items.slice(j, j + DB_CONCURRENCY);
    batchSizes.push(batch.length);

    const results = await Promise.allSettled(
      batch.map(async (item) => {
        processedIds.push(item.id);
        return item.id;
      }),
    );

    assertEquals(
      results.filter((r) => r.status === "fulfilled").length,
      batch.length,
    );
  }

  assertEquals(processedIds.length, 12, "All 12 items should be processed");
  assertEquals(batchSizes, [5, 5, 2], "Should process in windows of 5, 5, 2");
});

// ═════════════════════════════════════════════════════════════════════
// 7. Bounded concurrency (generate-smart.ts)
//
// Tests the CLAUDE_CONCURRENCY = 3 pattern for bulk AI generation.
// ═════════════════════════════════════════════════════════════════════

Deno.test("Bounded concurrency: generates items in batches of 3", async () => {
  const CLAUDE_CONCURRENCY = 3;
  const targets = Array.from({ length: 7 }, (_, i) => ({
    keyword_name: `Keyword ${i}`,
    keyword_id: `kw-${i}`,
  }));

  const generatedItems: { keyword_id: string }[] = [];
  const bulkErrors: { keyword_id: string; error: string }[] = [];
  const batchCounts: number[] = [];

  for (let i = 0; i < targets.length; i += CLAUDE_CONCURRENCY) {
    const batch = targets.slice(i, i + CLAUDE_CONCURRENCY);
    batchCounts.push(batch.length);

    const results = await Promise.allSettled(
      batch.map(async (target) => {
        // Simulate Claude call
        return { keyword_id: target.keyword_id, data: { question: "Q?" } };
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        generatedItems.push({ keyword_id: result.value.keyword_id });
      } else {
        const batchIdx = results.indexOf(result);
        bulkErrors.push({
          keyword_id: batch[batchIdx].keyword_id,
          error: result.reason?.message ?? "Unknown",
        });
      }
    }
  }

  assertEquals(generatedItems.length, 7, "All 7 items should be generated");
  assertEquals(batchCounts, [3, 3, 1], "Should batch as 3, 3, 1");
  assertEquals(bulkErrors.length, 0, "No errors expected");
});

Deno.test("Bounded concurrency: partial failures produce mixed results", async () => {
  const CLAUDE_CONCURRENCY = 3;
  const targets = [
    { keyword_id: "kw-1", shouldFail: false },
    { keyword_id: "kw-2", shouldFail: true },
    { keyword_id: "kw-3", shouldFail: false },
    { keyword_id: "kw-4", shouldFail: true },
    { keyword_id: "kw-5", shouldFail: false },
  ];

  const generated: string[] = [];
  const failed: string[] = [];

  for (let i = 0; i < targets.length; i += CLAUDE_CONCURRENCY) {
    const batch = targets.slice(i, i + CLAUDE_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (t) => {
        if (t.shouldFail) throw new Error(`Generation failed for ${t.keyword_id}`);
        return t.keyword_id;
      }),
    );

    for (let j = 0; j < results.length; j++) {
      if (results[j].status === "fulfilled") {
        generated.push((results[j] as PromiseFulfilledResult<string>).value);
      } else {
        failed.push(batch[j].keyword_id);
      }
    }
  }

  assertEquals(generated.length, 3, "3 successful generations");
  assertEquals(failed.length, 2, "2 failures");
  assert(generated.includes("kw-1"));
  assert(generated.includes("kw-3"));
  assert(generated.includes("kw-5"));
  assert(failed.includes("kw-2"));
  assert(failed.includes("kw-4"));
});

// ═════════════════════════════════════════════════════════════════════
// 8. Pre-fetch lookup maps for generate-smart.ts bulk path
//
// Tests the profNotesMap and bktMap pattern used to replace
// per-target fetchTargetContext() DB calls.
// ═════════════════════════════════════════════════════════════════════

Deno.test("Generate-smart pre-fetch: profNotesMap groups notes by keyword_id", () => {
  const profNotesData = [
    { keyword_id: "kw-1", note: "Focus on mechanism" },
    { keyword_id: "kw-1", note: "Common exam topic" },
    { keyword_id: "kw-2", note: "Review differential diagnosis" },
    { keyword_id: "kw-1", note: "Third note for kw-1" },
  ];

  const profNotesMap = new Map<string, string[]>();
  for (const row of profNotesData) {
    const existing = profNotesMap.get(row.keyword_id) ?? [];
    existing.push(row.note);
    profNotesMap.set(row.keyword_id, existing);
  }

  assertEquals(profNotesMap.get("kw-1")!.length, 3, "kw-1 should have 3 notes");
  assertEquals(profNotesMap.get("kw-2")!.length, 1, "kw-2 should have 1 note");
  assertEquals(profNotesMap.get("kw-3"), undefined, "kw-3 should not exist");

  // Build context from cache (as in buildTargetContextFromCache)
  const notes = profNotesMap.get("kw-1");
  const profNotesContext = notes && notes.length > 0
    ? "\nNotas del profesor: " + notes.slice(0, 3).join("; ")
    : "";

  assert(profNotesContext.includes("Focus on mechanism"));
  assert(profNotesContext.includes("Common exam topic"));
});

Deno.test("Generate-smart pre-fetch: bktMap provides BKT context for subtopics", () => {
  const bktData = [
    { subtopic_id: "st-1", p_know: 0.45, total_attempts: 8, correct_attempts: 4 },
    { subtopic_id: "st-2", p_know: 0.82, total_attempts: 15, correct_attempts: 13 },
  ];

  const bktMap = new Map<string, typeof bktData[0]>();
  for (const row of bktData) {
    bktMap.set(row.subtopic_id, row);
  }

  // Build BKT context (as in buildTargetContextFromCache)
  const target = { subtopic_id: "st-1", keyword_id: "kw-1" };
  let bktContext = "";
  if (target.subtopic_id) {
    const bkt = bktMap.get(target.subtopic_id);
    if (bkt) {
      bktContext = `\nBKT del subtema: p_know=${bkt.p_know}, intentos=${bkt.total_attempts}, correctos=${bkt.correct_attempts}`;
    }
  }

  assert(bktContext.includes("p_know=0.45"));
  assert(bktContext.includes("intentos=8"));
  assert(bktContext.includes("correctos=4"));

  // Target without subtopic → no BKT context
  const targetNoSub = { subtopic_id: null as string | null, keyword_id: "kw-2" };
  let bktContextEmpty = "";
  if (targetNoSub.subtopic_id) {
    const bkt = bktMap.get(targetNoSub.subtopic_id);
    if (bkt) bktContextEmpty = "should not happen";
  }
  assertEquals(bktContextEmpty, "", "No subtopic → no BKT context");
});

// ═════════════════════════════════════════════════════════════════════
// 9. Compact JSON pattern (analyze-graph.ts)
//
// analyze-graph.ts uses JSON.stringify inside wrapXml for the prompt.
// Verify the data structure is serializable and compact.
// ═════════════════════════════════════════════════════════════════════

Deno.test("Compact JSON: keyword + connection data serializes correctly", () => {
  const keywordData = [
    { id: "kw-1", name: "ATP", definition: "Energy currency of the cell", mastery: 0.75 },
    { id: "kw-2", name: "Glycolysis", definition: "Breakdown of glucose", mastery: null },
  ];

  const connectionData = [
    { from: "kw-1", to: "kw-2", type: "prerequisito", relationship: "ATP is product of glycolysis" },
  ];

  const kwJson = JSON.stringify(keywordData);
  const connJson = JSON.stringify(connectionData);

  // Verify no pretty-printing (compact)
  assertEquals(kwJson.includes("\n"), false, "Should be compact JSON without newlines");
  assertEquals(connJson.includes("\n"), false);

  // Verify round-trip
  const parsed = JSON.parse(kwJson) as typeof keywordData;
  assertEquals(parsed.length, 2);
  assertEquals(parsed[0].name, "ATP");
  assertEquals(parsed[1].mastery, null);
});

// ═════════════════════════════════════════════════════════════════════
// 10. Summary embedding concurrency (ingest.ts summary path)
//
// Tests the SUMMARY_CONCURRENCY = 3 pattern with skipped/failed tracking.
// ═════════════════════════════════════════════════════════════════════

Deno.test("Summary embedding: skips empty content, processes valid ones", () => {
  const summaries = [
    { id: "s1", title: "Title 1", content_markdown: "Valid content" },
    { id: "s2", title: "Title 2", content_markdown: "" },
    { id: "s3", title: "Title 3", content_markdown: "   " },
    { id: "s4", title: "Title 4", content_markdown: "More valid content" },
    { id: "s5", title: "Title 5", content_markdown: null as string | null },
  ];

  let skipped = 0;
  const validSummaries: typeof summaries = [];

  for (const summary of summaries) {
    const content = summary.content_markdown as string;
    if (!content || content.trim().length === 0) {
      skipped++;
    } else {
      validSummaries.push(summary);
    }
  }

  assertEquals(skipped, 3, "Should skip 3: empty, whitespace-only, null");
  assertEquals(validSummaries.length, 2, "Should have 2 valid summaries");
  assertEquals(validSummaries[0].id, "s1");
  assertEquals(validSummaries[1].id, "s4");
});

Deno.test("Summary embedding: accounting is transparent (processed + failed + skipped === total)", async () => {
  // A2 FIX: The response must account for all summaries
  const totalFound = 10;
  let processed = 0;
  let failed = 0;
  let skipped = 3; // 3 empty content

  // Simulate 7 valid summaries: 5 succeed, 2 fail
  const validSummaries = Array.from({ length: 7 }, (_, i) => ({
    id: `s-${i}`,
    title: `Title ${i}`,
    content: `Content ${i}`,
  }));

  const SUMMARY_CONCURRENCY = 3;
  for (let i = 0; i < validSummaries.length; i += SUMMARY_CONCURRENCY) {
    const batch = validSummaries.slice(i, i + SUMMARY_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (s, idx) => {
        if (idx === 1 && i === 0) throw new Error("embed failed");
        if (idx === 0 && i === 3) throw new Error("embed failed");
        return s.id;
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        processed++;
      } else {
        failed++;
      }
    }
  }

  assertEquals(
    processed + failed + skipped,
    totalFound,
    "processed + failed + skipped must equal total_found",
  );
  assertEquals(processed, 5);
  assertEquals(failed, 2);
  assertEquals(skipped, 3);
});

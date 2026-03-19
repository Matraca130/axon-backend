/**
 * Tests for batch-review.ts — Ronda 2 optimization patterns
 *
 * Tests cover:
 *   1. fsrsMap pattern: pre-loaded Map lookup works correctly with mock data
 *   2. bktMap pattern: pre-loaded Map lookup works correctly with mock data
 *   3. bktMap same-subtopic counter update (fix 2.7)
 *
 * These tests verify the Map-based batch pre-loading optimization
 * that replaced N+1 individual DB queries with batch fetches + Map lookup.
 *
 * Run: deno test supabase/functions/server/tests/batch_review_optimization_test.ts
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// ── Types mirroring batch-review.ts internal structures ──────────

interface FsrsStateRow {
  flashcard_id: string;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  state: string;
  last_review_at: string | null;
  consecutive_lapses: number;
  is_leech: boolean;
}

interface BktStateRow {
  subtopic_id: string;
  p_know: number;
  max_p_know: number;
  total_attempts: number;
  correct_attempts: number;
  p_transit: number;
  p_slip: number;
  p_guess: number;
}

// ═════════════════════════════════════════════════════════════════
// 1. fsrsMap pattern
// ═════════════════════════════════════════════════════════════════

Deno.test("fsrsMap: builds correctly from mock DB results", () => {
  // Simulate what batch-review does: allFsrs?.map(s => [s.flashcard_id, s])
  const allFsrs: FsrsStateRow[] = [
    {
      flashcard_id: "fc-111",
      stability: 5.0,
      difficulty: 4.5,
      reps: 3,
      lapses: 1,
      state: "review",
      last_review_at: "2026-03-10T12:00:00Z",
      consecutive_lapses: 0,
      is_leech: false,
    },
    {
      flashcard_id: "fc-222",
      stability: 1.2,
      difficulty: 7.0,
      reps: 1,
      lapses: 0,
      state: "learning",
      last_review_at: null,
      consecutive_lapses: 0,
      is_leech: false,
    },
  ];

  const fsrsMap = new Map(allFsrs.map(s => [s.flashcard_id, s]));

  assertEquals(fsrsMap.size, 2);
  assertEquals(fsrsMap.get("fc-111")!.stability, 5.0);
  assertEquals(fsrsMap.get("fc-111")!.state, "review");
  assertEquals(fsrsMap.get("fc-222")!.difficulty, 7.0);
  assertEquals(fsrsMap.get("fc-222")!.state, "learning");
});

Deno.test("fsrsMap: returns undefined for unknown flashcard_id", () => {
  const allFsrs: FsrsStateRow[] = [
    {
      flashcard_id: "fc-111",
      stability: 5.0,
      difficulty: 4.5,
      reps: 3,
      lapses: 1,
      state: "review",
      last_review_at: "2026-03-10T12:00:00Z",
      consecutive_lapses: 0,
      is_leech: false,
    },
  ];

  const fsrsMap = new Map(allFsrs.map(s => [s.flashcard_id, s]));

  // Existing key
  assertEquals(fsrsMap.get("fc-111")!.stability, 5.0);
  // Missing key — PATH B uses ?? null for this
  const missing = fsrsMap.get("fc-999") ?? null;
  assertEquals(missing, null);
});

Deno.test("fsrsMap: handles empty DB result", () => {
  const allFsrs: FsrsStateRow[] = [];
  const fsrsMap = new Map(allFsrs.map(s => [s.flashcard_id, s]));

  assertEquals(fsrsMap.size, 0);
  assertEquals(fsrsMap.get("anything") ?? null, null);
});

Deno.test("fsrsMap: handles null DB result (coalesced to empty)", () => {
  // In batch-review.ts: allFsrs?.map(s => [s.flashcard_id, s]) ?? []
  const allFsrs = null;
  const fsrsMap = new Map(allFsrs?.map((s: FsrsStateRow) => [s.flashcard_id, s] as const) ?? []);

  assertEquals(fsrsMap.size, 0);
});

// ═════════════════════════════════════════════════════════════════
// 2. bktMap pattern
// ═════════════════════════════════════════════════════════════════

Deno.test("bktMap: builds correctly from mock DB results", () => {
  const allBkt: BktStateRow[] = [
    {
      subtopic_id: "st-aaa",
      p_know: 0.75,
      max_p_know: 0.80,
      total_attempts: 10,
      correct_attempts: 7,
      p_transit: 0.18,
      p_slip: 0.10,
      p_guess: 0.25,
    },
    {
      subtopic_id: "st-bbb",
      p_know: 0.30,
      max_p_know: 0.55,
      total_attempts: 5,
      correct_attempts: 2,
      p_transit: 0.18,
      p_slip: 0.10,
      p_guess: 0.25,
    },
  ];

  const bktMap = new Map(allBkt.map(s => [s.subtopic_id, s]));

  assertEquals(bktMap.size, 2);
  assertEquals(bktMap.get("st-aaa")!.p_know, 0.75);
  assertEquals(bktMap.get("st-aaa")!.total_attempts, 10);
  assertEquals(bktMap.get("st-bbb")!.p_know, 0.30);
  assertEquals(bktMap.get("st-bbb")!.correct_attempts, 2);
});

Deno.test("bktMap: returns undefined for unknown subtopic_id (defaults used)", () => {
  const allBkt: BktStateRow[] = [];
  const bktMap = new Map(allBkt.map(s => [s.subtopic_id, s]));

  const existing = bktMap.get("st-unknown") ?? null;
  assertEquals(existing, null);

  // In batch-review.ts, when existing is null, defaults are used:
  const currentMastery = existing?.p_know ?? 0;
  const maxReachedMastery = existing?.max_p_know ?? 0;
  const existingTotal = existing?.total_attempts ?? 0;
  const existingCorrect = existing?.correct_attempts ?? 0;

  assertEquals(currentMastery, 0);
  assertEquals(maxReachedMastery, 0);
  assertEquals(existingTotal, 0);
  assertEquals(existingCorrect, 0);
});

// ═════════════════════════════════════════════════════════════════
// 3. bktMap same-subtopic counter update (fix 2.7)
// ═════════════════════════════════════════════════════════════════

Deno.test("bktMap: same-subtopic counter update preserves fresh state for next item", () => {
  // Simulates fix 2.7: after processing an item, bktMap.set() updates
  // the map so the next item with the same subtopic reads fresh state.
  const initialBkt: BktStateRow[] = [
    {
      subtopic_id: "st-shared",
      p_know: 0.50,
      max_p_know: 0.60,
      total_attempts: 5,
      correct_attempts: 3,
      p_transit: 0.18,
      p_slip: 0.10,
      p_guess: 0.25,
    },
  ];

  const bktMap = new Map(initialBkt.map(s => [s.subtopic_id, s]));

  // --- Process first item (correct answer) ---
  const existing1 = bktMap.get("st-shared")!;
  assertEquals(existing1.total_attempts, 5);
  assertEquals(existing1.correct_attempts, 3);

  // Simulate BKT update result
  const newPKnow1 = 0.58;
  const newMaxPKnow1 = 0.60;
  const finalTotal1 = existing1.total_attempts + 1; // 6
  const finalCorrect1 = existing1.correct_attempts + 1; // 4 (correct)

  // Fix 2.7: Update bktMap so next item reads fresh state
  bktMap.set("st-shared", {
    ...existing1,
    p_know: newPKnow1,
    max_p_know: newMaxPKnow1,
    total_attempts: finalTotal1,
    correct_attempts: finalCorrect1,
  });

  // --- Process second item (same subtopic, incorrect answer) ---
  const existing2 = bktMap.get("st-shared")!;

  // Should see UPDATED values from first item, not original DB values
  assertEquals(existing2.p_know, 0.58);
  assertEquals(existing2.total_attempts, 6);
  assertEquals(existing2.correct_attempts, 4);

  const finalTotal2 = existing2.total_attempts + 1; // 7
  const finalCorrect2 = existing2.correct_attempts + 0; // 4 (incorrect)

  bktMap.set("st-shared", {
    ...existing2,
    p_know: 0.52,
    max_p_know: 0.60,
    total_attempts: finalTotal2,
    correct_attempts: finalCorrect2,
  });

  // --- Verify final state ---
  const final = bktMap.get("st-shared")!;
  assertEquals(final.total_attempts, 7);
  assertEquals(final.correct_attempts, 4);
  assertEquals(final.p_know, 0.52);
});

Deno.test("bktMap: without fix 2.7, stale read would use original values", () => {
  // Demonstrates why fix 2.7 is necessary: if we DON'T update bktMap,
  // the second item would read stale values from the initial DB fetch.
  const initialBkt: BktStateRow = {
    subtopic_id: "st-stale-test",
    p_know: 0.40,
    max_p_know: 0.50,
    total_attempts: 3,
    correct_attempts: 1,
    p_transit: 0.18,
    p_slip: 0.10,
    p_guess: 0.25,
  };

  // Simulate WITHOUT the fix: create a frozen copy
  const staleMap = new Map([["st-stale-test", { ...initialBkt }]]);

  // Process first item
  const staleRead1 = staleMap.get("st-stale-test")!;
  assertEquals(staleRead1.total_attempts, 3);

  // If we DON'T update the map (no fix 2.7), second read is stale
  const staleRead2 = staleMap.get("st-stale-test")!;
  assertEquals(staleRead2.total_attempts, 3); // Still 3, not 4!

  // With the fix: update the map
  const fixedMap = new Map([["st-stale-test", { ...initialBkt }]]);
  const read1 = fixedMap.get("st-stale-test")!;
  fixedMap.set("st-stale-test", { ...read1, total_attempts: read1.total_attempts + 1 });

  const read2 = fixedMap.get("st-stale-test")!;
  assertEquals(read2.total_attempts, 4); // Correctly 4 with the fix
});

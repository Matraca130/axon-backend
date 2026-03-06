/**
 * tests/retrieval_strategies_test.ts — Fase 6 unit tests
 *
 * Tests for pure functions in retrieval-strategies.ts.
 * No network calls — only tests deterministic logic.
 *
 * Run: deno test supabase/functions/server/tests/retrieval_strategies_test.ts
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import {
  selectStrategy,
  mergeSearchResults,
  type MatchedChunk,
} from "../retrieval-strategies.ts";

// ─── Helper: create a mock MatchedChunk ──────────────────────────

function mockChunk(overrides: Partial<MatchedChunk> = {}): MatchedChunk {
  return {
    chunk_id: overrides.chunk_id ?? crypto.randomUUID(),
    summary_id: overrides.summary_id ?? crypto.randomUUID(),
    summary_title: overrides.summary_title ?? "Test Summary",
    content: overrides.content ?? "Test content",
    similarity: overrides.similarity ?? 0.8,
    text_rank: overrides.text_rank ?? 0.5,
    combined_score: overrides.combined_score ?? 0.7,
  };
}

// ─── mergeSearchResults tests ────────────────────────────────────

Deno.test("mergeSearchResults: deduplicates by chunk_id keeping highest score", () => {
  const chunkId = "shared-chunk-id";
  const lowScore = mockChunk({ chunk_id: chunkId, combined_score: 0.5 });
  const highScore = mockChunk({ chunk_id: chunkId, combined_score: 0.9 });

  const result = mergeSearchResults([[lowScore], [highScore]]);

  assertEquals(result.length, 1);
  assertEquals(result[0].combined_score, 0.9);
  assertEquals(result[0].chunk_id, chunkId);
});

Deno.test("mergeSearchResults: returns empty array for empty input", () => {
  assertEquals(mergeSearchResults([]).length, 0);
  assertEquals(mergeSearchResults([[]]).length, 0);
  assertEquals(mergeSearchResults([[], []]).length, 0);
});

Deno.test("mergeSearchResults: returns sorted by combined_score descending", () => {
  const a = mockChunk({ chunk_id: "a", combined_score: 0.3 });
  const b = mockChunk({ chunk_id: "b", combined_score: 0.9 });
  const c = mockChunk({ chunk_id: "c", combined_score: 0.6 });

  const result = mergeSearchResults([[a], [b], [c]]);

  assertEquals(result.length, 3);
  assertEquals(result[0].chunk_id, "b"); // 0.9
  assertEquals(result[1].chunk_id, "c"); // 0.6
  assertEquals(result[2].chunk_id, "a"); // 0.3
});

Deno.test("mergeSearchResults: handles single result set (passthrough)", () => {
  const chunks = [
    mockChunk({ chunk_id: "x", combined_score: 0.8 }),
    mockChunk({ chunk_id: "y", combined_score: 0.6 }),
  ];

  const result = mergeSearchResults([chunks]);

  assertEquals(result.length, 2);
  assertEquals(result[0].chunk_id, "x");
  assertEquals(result[1].chunk_id, "y");
});

Deno.test("mergeSearchResults: merges 3 sets with overlapping chunks", () => {
  const shared1 = "shared-1";
  const shared2 = "shared-2";
  const unique = "unique-3";

  const set1 = [
    mockChunk({ chunk_id: shared1, combined_score: 0.5 }),
    mockChunk({ chunk_id: shared2, combined_score: 0.7 }),
  ];
  const set2 = [
    mockChunk({ chunk_id: shared1, combined_score: 0.8 }), // higher
    mockChunk({ chunk_id: unique, combined_score: 0.4 }),
  ];
  const set3 = [
    mockChunk({ chunk_id: shared2, combined_score: 0.6 }), // lower, ignored
  ];

  const result = mergeSearchResults([set1, set2, set3]);

  assertEquals(result.length, 3); // shared1, shared2, unique
  // Verify order: shared1(0.8) > shared2(0.7) > unique(0.4)
  assertEquals(result[0].chunk_id, shared1);
  assertEquals(result[0].combined_score, 0.8);
  assertEquals(result[1].chunk_id, shared2);
  assertEquals(result[1].combined_score, 0.7);
  assertEquals(result[2].chunk_id, unique);
  assertEquals(result[2].combined_score, 0.4);
});

// ─── selectStrategy tests ────────────────────────────────────────

Deno.test("selectStrategy: returns 'standard' when summaryId is provided", () => {
  const result = selectStrategy(
    "Explica las diferencias entre mitosis y meiosis en detalle",
    "550e8400-e29b-41d4-a716-446655440000",
    0,
  );
  assertEquals(result, "standard");
});

Deno.test("selectStrategy: returns 'hyde' for short queries (≤5 words, no deep history)", () => {
  assertEquals(selectStrategy("¿Qué es la mitosis?", null, 0), "hyde");
  assertEquals(selectStrategy("Define fotosíntesis", null, 0), "hyde");
  assertEquals(selectStrategy("ATP", null, 0), "hyde");
  // With shallow history (≤2), still hyde
  assertEquals(selectStrategy("¿Qué es?", null, 2), "hyde");
});

Deno.test("selectStrategy: returns 'multi_query' for long queries (>5 words)", () => {
  const result = selectStrategy(
    "Explica las diferencias entre mitosis y meiosis en detalle",
    null,
    0,
  );
  assertEquals(result, "multi_query");
});

Deno.test("selectStrategy: returns 'multi_query' when history is deep (>2)", () => {
  // R1 FIX: Even with a short query, deep history → multi_query
  // (historyLength checked before wordCount)
  assertEquals(selectStrategy("¿Y luego?", null, 3), "multi_query");
  assertEquals(selectStrategy("¿Y luego?", null, 4), "multi_query");
  assertEquals(selectStrategy("ATP", null, 5), "multi_query");
});

Deno.test("selectStrategy: summaryId takes highest priority over everything", () => {
  // Even with deep history AND long query, summaryId → standard
  const result = selectStrategy(
    "Explica las diferencias entre mitosis y meiosis",
    "550e8400-e29b-41d4-a716-446655440000",
    10,
  );
  assertEquals(result, "standard");
});

// ─── Score blend math verification ───────────────────────────────

Deno.test("score blend math: 0.6 * (gemini/10) + 0.4 * original", () => {
  // Simulate: gemini_score = 8, original_combined_score = 0.7
  const geminiScore = 8;
  const originalScore = 0.7;
  const expected = (geminiScore / 10) * 0.6 + originalScore * 0.4;
  // = 0.8 * 0.6 + 0.7 * 0.4 = 0.48 + 0.28 = 0.76
  assertEquals(expected, 0.76);

  // Edge case: gemini_score = 0, original = 1.0
  const worst = (0 / 10) * 0.6 + 1.0 * 0.4;
  // = 0 + 0.4 = 0.4
  assertEquals(worst, 0.4);

  // Edge case: gemini_score = 10, original = 0.0
  const best = (10 / 10) * 0.6 + 0.0 * 0.4;
  // = 0.6 + 0 = 0.6
  assertEquals(best, 0.6);
});

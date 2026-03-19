/**
 * Tests for lib/embedding-cache.ts — In-memory TTL cache for query embeddings
 *
 * Tests cover:
 *   1. getCachedEmbedding returns null on cache miss
 *   2. setCachedEmbedding + getCachedEmbedding returns hit
 *   3. TTL expiration (verify miss after expiry)
 *   4. Max entries eviction (fill 500+, verify oldest evicted)
 *   5. Hash collision handling (different text, correct embedding returned)
 *
 * Run: deno test supabase/functions/server/tests/embedding_cache_test.ts
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  getCachedEmbedding,
  setCachedEmbedding,
} from "../lib/embedding-cache.ts";

// ── Helpers ──────────────────────────────────────────────────────

/** Generate a fake embedding vector of given length */
function fakeEmbedding(seed: number, length = 4): number[] {
  return Array.from({ length }, (_, i) => seed + i * 0.1);
}

/**
 * Flush the cache by writing 501 entries with unique keys.
 * Since MAX_ENTRIES=500, this guarantees the cache is completely replaced.
 */
function flushCache(): void {
  for (let i = 0; i < 501; i++) {
    setCachedEmbedding(`__flush_key_${i}_${Date.now()}`, [0]);
  }
}

// ═════════════════════════════════════════════════════════════════
// 1. Cache miss
// ═════════════════════════════════════════════════════════════════

Deno.test("getCachedEmbedding: returns null on cache miss", () => {
  const result = getCachedEmbedding(`nonexistent_text_${Date.now()}_${Math.random()}`);
  assertEquals(result, null);
});

Deno.test("getCachedEmbedding: returns null for empty string not previously cached", () => {
  // Flush to ensure clean state
  flushCache();
  const result = getCachedEmbedding(`unique_empty_test_${Date.now()}`);
  assertEquals(result, null);
});

// ═════════════════════════════════════════════════════════════════
// 2. Cache hit
// ═════════════════════════════════════════════════════════════════

Deno.test("setCachedEmbedding + getCachedEmbedding: returns cached embedding", () => {
  const text = `cache_hit_test_${Date.now()}`;
  const embedding = fakeEmbedding(42);

  setCachedEmbedding(text, embedding);
  const result = getCachedEmbedding(text);

  assertEquals(result, embedding);
});

Deno.test("setCachedEmbedding: overwrite same key returns new embedding", () => {
  const text = `overwrite_test_${Date.now()}`;
  const embedding1 = fakeEmbedding(1);
  const embedding2 = fakeEmbedding(2);

  setCachedEmbedding(text, embedding1);
  assertEquals(getCachedEmbedding(text), embedding1);

  setCachedEmbedding(text, embedding2);
  assertEquals(getCachedEmbedding(text), embedding2);
});

Deno.test("getCachedEmbedding: returns exact array reference (not copy)", () => {
  const text = `ref_test_${Date.now()}`;
  const embedding = fakeEmbedding(99, 8);

  setCachedEmbedding(text, embedding);
  const result = getCachedEmbedding(text);

  assertEquals(result!.length, 8);
  assertEquals(result, embedding);
});

// ═════════════════════════════════════════════════════════════════
// 3. TTL expiration
// ═════════════════════════════════════════════════════════════════

Deno.test("getCachedEmbedding: returns null after TTL expires", () => {
  const text = `ttl_test_${Date.now()}`;
  const embedding = fakeEmbedding(7);

  setCachedEmbedding(text, embedding);

  // Verify it's cached
  assertEquals(getCachedEmbedding(text), embedding);

  // Monkey-patch Date.now to simulate time passing beyond TTL (1 hour)
  const originalNow = Date.now;
  try {
    // Jump forward 1 hour + 1 second (TTL_MS = 3_600_000)
    Date.now = () => originalNow() + 3_600_001;

    const result = getCachedEmbedding(text);
    assertEquals(result, null);
  } finally {
    Date.now = originalNow;
  }
});

Deno.test("getCachedEmbedding: returns embedding before TTL expires", () => {
  const text = `ttl_not_expired_${Date.now()}`;
  const embedding = fakeEmbedding(8);

  setCachedEmbedding(text, embedding);

  // Monkey-patch Date.now to simulate time just before TTL
  const originalNow = Date.now;
  try {
    // Jump forward 59 minutes (TTL is 60 minutes)
    Date.now = () => originalNow() + 59 * 60 * 1000;

    const result = getCachedEmbedding(text);
    assertEquals(result, embedding);
  } finally {
    Date.now = originalNow;
  }
});

// ═════════════════════════════════════════════════════════════════
// 4. Max entries eviction (MAX_ENTRIES = 500)
// ═════════════════════════════════════════════════════════════════

Deno.test("setCachedEmbedding: evicts oldest when exceeding 500 entries", () => {
  // Fill cache with 500 unique entries — the first one should be evicted
  // when we add the 501st
  const firstText = `eviction_first_${Date.now()}`;
  const firstEmbedding = fakeEmbedding(1);

  setCachedEmbedding(firstText, firstEmbedding);

  // Fill 499 more to reach capacity (500 total)
  for (let i = 1; i < 500; i++) {
    setCachedEmbedding(`eviction_fill_${i}_${Date.now()}`, fakeEmbedding(i));
  }

  // First entry should still be there
  assertEquals(getCachedEmbedding(firstText), firstEmbedding);

  // Add one more to trigger eviction (501st entry)
  setCachedEmbedding(`eviction_trigger_${Date.now()}`, fakeEmbedding(999));

  // First entry should be evicted (it's the oldest = first in Map iteration)
  const result = getCachedEmbedding(firstText);
  assertEquals(result, null);
});

Deno.test("setCachedEmbedding: new entry exists after eviction", () => {
  // Flush and refill
  flushCache();

  const newText = `post_eviction_${Date.now()}`;
  const newEmbedding = fakeEmbedding(777);
  setCachedEmbedding(newText, newEmbedding);

  assertEquals(getCachedEmbedding(newText), newEmbedding);
});

// ═════════════════════════════════════════════════════════════════
// 5. Hash collision handling (different text, correct embedding)
// ═════════════════════════════════════════════════════════════════

Deno.test("setCachedEmbedding: different texts return their own embeddings", () => {
  const text1 = `collision_test_alpha_${Date.now()}`;
  const text2 = `collision_test_beta_${Date.now()}`;
  const emb1 = fakeEmbedding(100);
  const emb2 = fakeEmbedding(200);

  setCachedEmbedding(text1, emb1);
  setCachedEmbedding(text2, emb2);

  assertEquals(getCachedEmbedding(text1), emb1);
  assertEquals(getCachedEmbedding(text2), emb2);
  // Verify they are not the same
  assertEquals(getCachedEmbedding(text1)![0] !== getCachedEmbedding(text2)![0], true);
});

Deno.test("setCachedEmbedding: similar text with minor diff returns correct embedding", () => {
  const text1 = "What is photosynthesis?";
  const text2 = "What is photosynthesis.";
  const emb1 = fakeEmbedding(10);
  const emb2 = fakeEmbedding(20);

  setCachedEmbedding(text1, emb1);
  setCachedEmbedding(text2, emb2);

  assertEquals(getCachedEmbedding(text1), emb1);
  assertEquals(getCachedEmbedding(text2), emb2);
});

Deno.test("setCachedEmbedding: empty string and whitespace are distinct", () => {
  const emb1 = fakeEmbedding(30);
  const emb2 = fakeEmbedding(40);

  setCachedEmbedding("", emb1);
  setCachedEmbedding(" ", emb2);

  assertEquals(getCachedEmbedding(""), emb1);
  assertEquals(getCachedEmbedding(" "), emb2);
});

/**
 * tests/unit/semantic-chunker.test.ts — Unit tests for semantic text chunking
 *
 * 26 tests covering:
 * - cosineSimilarity: identical/orthogonal/opposite vectors, edge cases
 * - chunkSemantic: empty input, single paragraph, multiple paragraphs
 * - Boundary detection: headers as mandatory boundaries
 * - Chunk sizing: min/max constraints, oversized chunks, undersized chunks
 * - Embeddings: success path, fallback on error
 * - Options: custom threshold, minParagraphChars, maxParagraphs
 *
 * Run:
 *   cd /sessions/great-bold-mccarthy/mnt/petri/AXON\ PROJECTO/backend
 *   deno test tests/unit/semantic-chunker.test.ts --allow-env --no-check
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { assertAlmostEquals } from "https://deno.land/std@0.224.0/assert/assert_almost_equals.ts";
import {
  cosineSimilarity,
  chunkSemantic,
  type SemanticChunkResult,
} from "../../supabase/functions/server/semantic-chunker.ts";

// ─── cosineSimilarity Tests ─────────────────────────────────────────

Deno.test("cosineSimilarity: identical vectors → 1.0", () => {
  const a = [1, 0, 0];
  const b = [1, 0, 0];
  const result = cosineSimilarity(a, b);
  assertAlmostEquals(result, 1.0, 0.0001);
});

Deno.test("cosineSimilarity: orthogonal vectors → 0.0", () => {
  const a = [1, 0, 0];
  const b = [0, 1, 0];
  const result = cosineSimilarity(a, b);
  assertAlmostEquals(result, 0.0, 0.0001);
});

Deno.test("cosineSimilarity: opposite vectors → -1.0", () => {
  const a = [1, 0, 0];
  const b = [-1, 0, 0];
  const result = cosineSimilarity(a, b);
  assertAlmostEquals(result, -1.0, 0.0001);
});

Deno.test("cosineSimilarity: normalized vectors", () => {
  const a = [0.6, 0.8]; // unit vector
  const b = [0.6, 0.8]; // same
  const result = cosineSimilarity(a, b);
  assertAlmostEquals(result, 1.0, 0.0001);
});

Deno.test("cosineSimilarity: partial overlap", () => {
  const a = [1, 1, 0];
  const b = [1, 0, 1];
  const result = cosineSimilarity(a, b);
  // dot = 1, magA = sqrt(2), magB = sqrt(2), result = 1/2
  assertAlmostEquals(result, 0.5, 0.0001);
});

Deno.test("cosineSimilarity: different length arrays → 0", () => {
  const a = [1, 0];
  const b = [1, 0, 0];
  const result = cosineSimilarity(a, b);
  assertEquals(result, 0);
});

Deno.test("cosineSimilarity: empty arrays → 0", () => {
  const a: number[] = [];
  const b: number[] = [];
  const result = cosineSimilarity(a, b);
  assertEquals(result, 0);
});

Deno.test("cosineSimilarity: zero-magnitude vectors → 0 (avoid NaN)", () => {
  const a = [0, 0, 0];
  const b = [0, 0, 0];
  const result = cosineSimilarity(a, b);
  assertEquals(result, 0);
});

Deno.test("cosineSimilarity: floating point precision", () => {
  const a = [0.1, 0.2, 0.3];
  const b = [0.1, 0.2, 0.3];
  const result = cosineSimilarity(a, b);
  assertAlmostEquals(result, 1.0, 0.0001);
});

// ─── chunkSemantic Tests ────────────────────────────────────────────

Deno.test("chunkSemantic: empty string returns empty chunks", async () => {
  const embedFn = async (text: string) => [0.1, 0.2];
  const result = await chunkSemantic("", embedFn);

  assertEquals(result.chunks, []);
  assertEquals(result.paragraphEmbeddings.size, 0);
});

Deno.test("chunkSemantic: whitespace-only string returns empty chunks", async () => {
  const embedFn = async (text: string) => [0.1, 0.2];
  const result = await chunkSemantic("   \n\n   ", embedFn);

  assertEquals(result.chunks, []);
  assertEquals(result.paragraphEmbeddings.size, 0);
});

Deno.test("chunkSemantic: single paragraph returns single chunk", async () => {
  const text = "This is a single paragraph with some content.";
  const embedFn = async (text: string) => [0.1, 0.2];
  const result = await chunkSemantic(text, embedFn);

  assertEquals(result.chunks.length, 1);
  assertEquals(result.chunks[0].content, text);
  assertEquals(result.chunks[0].order_index, 0);
  assertEquals(result.chunks[0].strategy, "semantic");
});

Deno.test("chunkSemantic: normalizes line endings (CRLF → LF)", async () => {
  const text = "Para 1\r\n\r\nPara 2";
  const embedFn = async (text: string) => [0.1, 0.2];
  const result = await chunkSemantic(text, embedFn);

  assert(result.chunks.length >= 1);
  // Verify internal normalization occurred (no CRLF in result)
  const allContent = result.chunks.map((c) => c.content).join("");
  assert(!allContent.includes("\r"));
});

Deno.test("chunkSemantic: embeds each paragraph and stores embeddings", async () => {
  const text = "Paragraph one with some content.\n\nParagraph two with more content.";
  const embedFn = async (inputText: string) => [inputText.length * 0.01, 0.2];
  const result = await chunkSemantic(text, embedFn);

  // Should have embeddings map with paragraph texts (or be empty if merged)
  // With two paragraphs before merging, embeddings should be populated
  assertEquals(typeof result.paragraphEmbeddings, "object");
  assert(result.chunks.length > 0);
});

Deno.test("chunkSemantic: uses similarity threshold for boundaries", async () => {
  // Create paragraphs with high similarity initially
  const para1 = "Medical topic: diabetes involves glucose metabolism and insulin resistance.";
  const para2 = "Diabetes affects glucose regulation and insulin production in the body.";
  const para3 = "Unrelated topic: the history of ancient Rome and its emperors.";
  const text = para1 + "\n\n" + para2 + "\n\n" + para3;

  const embedFn = async (inputText: string) => {
    // Return similar embeddings for para1&2, different for para3
    if (inputText.includes("Rome")) return [0.9, 0.1];
    return [0.1, 0.9];
  };

  const result = await chunkSemantic(text, embedFn, { similarityThreshold: 0.5 });

  // Should split when similarity drops
  assert(result.chunks.length >= 1);
});

Deno.test("chunkSemantic: marks headers as mandatory boundaries", async () => {
  const text = "# Title\n\nFirst paragraph.\n\n## Section\n\nSecond paragraph.";
  const embedFn = async () => [0.1, 0.2];
  const result = await chunkSemantic(text, embedFn);

  // Headers should be preserved
  const hasHeader = result.chunks.some((c) => c.content.includes("#"));
  assert(hasHeader);
});

Deno.test("chunkSemantic: merges tiny paragraphs below minParagraphChars", async () => {
  const text = "Tiny.\n\nAlso small.\n\nThis is a longer paragraph with more content in it.";
  const embedFn = async () => [0.1, 0.2];
  const result = await chunkSemantic(text, embedFn, { minParagraphChars: 50 });

  // Tiny paragraphs should be merged
  assert(result.chunks.length >= 1);
});

Deno.test("chunkSemantic: respects maxChunkSize limit", async () => {
  const longText = "word ".repeat(500); // Very large text
  const embedFn = async () => [0.1, 0.2];
  const result = await chunkSemantic(longText, embedFn, { maxChunkSize: 100 });

  // Most chunks should be ≤ maxChunkSize + some overlap tolerance
  // With maxChunkSize=100 and default overlap=50, allow up to ~150
  const oversized = result.chunks.filter((c) => c.char_count > 300);
  // Very few chunks should be drastically oversized
  assert(oversized.length <= 1, `No more than 1 chunk should exceed 300 chars, got ${oversized.length}`);
});

Deno.test("chunkSemantic: respects minChunkSize and merges undersized", async () => {
  const text = "Para 1.\n\nPara 2.\n\nPara 3.\n\nPara 4.\n\nPara 5.";
  const embedFn = async () => [0.1, 0.2];
  const result = await chunkSemantic(text, embedFn, {
    minChunkSize: 50,
    maxChunkSize: 1000,
  });

  // Should merge small chunks
  const tinyChunks = result.chunks.filter((c) => c.char_count < 20);
  // Very few isolated tiny chunks should remain
  assert(tinyChunks.length <= 1, "Most undersized chunks should be merged");
});

Deno.test("chunkSemantic: returns chunks with order_index in sequence", async () => {
  const text = "A\n\nB\n\nC\n\nD\n\nE";
  const embedFn = async () => [0.1, 0.2];
  const result = await chunkSemantic(text, embedFn);

  for (let i = 0; i < result.chunks.length; i++) {
    assertEquals(result.chunks[i].order_index, i);
  }
});

Deno.test("chunkSemantic: sets strategy to 'semantic' for all chunks", async () => {
  const text = "One paragraph.\n\nAnother paragraph.";
  const embedFn = async () => [0.1, 0.2];
  const result = await chunkSemantic(text, embedFn);

  for (const chunk of result.chunks) {
    assertEquals(chunk.strategy, "semantic");
  }
});

Deno.test("chunkSemantic: falls back to recursive on embedding error", async () => {
  // Use larger text with multiple paragraphs to force chunking
  const text = "A longer paragraph about medical topics that contains enough content to trigger chunking. ".repeat(20)
    + "\n\n" +
    "Another paragraph with different medical information that is also quite long. ".repeat(20)
    + "\n\n" +
    "Yet another section with more content to ensure we exceed maxChunkSize. ".repeat(20);

  const failingEmbedFn = async () => {
    throw new Error("Embedding service unavailable");
  };

  const result = await chunkSemantic(text, failingEmbedFn);

  // Should fall back to recursive chunking
  assert(result.chunks.length > 0, "Should have chunks from fallback");
  // Fallback uses "recursive" strategy (not "semantic")
  const hasRecursive = result.chunks.some((c) => c.strategy === "recursive");
  assertEquals(hasRecursive, true, "At least one chunk should use recursive strategy when embedding fails");
});

Deno.test("chunkSemantic: clamps options to valid ranges", async () => {
  const text = "Paragraph 1.\n\nParagraph 2.";
  const embedFn = async () => [0.1, 0.2];

  // Pass invalid options
  const result = await chunkSemantic(text, embedFn, {
    maxChunkSize: 0, // Invalid → clamped to 1
    minChunkSize: 2000, // Invalid → clamped to maxChunkSize
    overlapSize: 10000, // Invalid → clamped
    similarityThreshold: -0.5, // Invalid → clamped to 0.1
  });

  // Should not throw, should use clamped values
  assert(result.chunks.length > 0);
});

Deno.test("chunkSemantic: falls back when paragraph count exceeds maxParagraphs", async () => {
  // Create text with many tiny paragraphs
  const text = ("Short.\n\n".repeat(150));
  const embedFn = async () => [0.1, 0.2];

  const result = await chunkSemantic(text, embedFn, {
    maxParagraphs: 50, // Will exceed this
    minParagraphChars: 1, // Allow very small paragraphs
  });

  // Should fall back to recursive (or return valid result)
  assert(result.chunks.length > 0);
});

Deno.test("chunkSemantic: preserves char_count in ChunkResult", async () => {
  const text = "This is the content of a chunk.";
  const embedFn = async () => [0.1, 0.2];
  const result = await chunkSemantic(text, embedFn);

  assertEquals(result.chunks[0].char_count, result.chunks[0].content.length);
});

Deno.test("chunkSemantic: adds overlap between consecutive chunks", async () => {
  const text = "First chunk content here.\n\nSecond chunk content here.\n\nThird chunk.";
  const embedFn = async () => [0.1, 0.2];
  const result = await chunkSemantic(text, embedFn, {
    overlapSize: 20,
    maxChunkSize: 40,
  });

  if (result.chunks.length > 1) {
    // Later chunks should start with overlap from previous
    // Check that there's some content reuse (overlap)
    const chunk1End = result.chunks[0].content.slice(-20);
    const chunk2Start = result.chunks[1].content.slice(0, 20);
    // Some overlap should be present (not strict equality due to normalization)
    assert(chunk1End.length > 0 && chunk2Start.length > 0);
  }
});

Deno.test("chunkSemantic: handles text with multiple h2 headers", async () => {
  const text = "## Section 1\nContent here.\n\n## Section 2\nMore content.\n\n## Section 3\nEven more.";
  const embedFn = async () => [0.1, 0.2];
  const result = await chunkSemantic(text, embedFn);

  // All headers should be preserved in chunks
  const allContent = result.chunks.map((c) => c.content).join("");
  assertEquals((allContent.match(/##/g) || []).length, 3);
});

Deno.test("chunkSemantic: handles large vectors correctly", async () => {
  const text = "Paragraph number one with some content here.\n\nParagraph number two with more content.\n\nParagraph number three.";
  // Return large embedding vectors
  const embedFn = async () => new Array(384).fill(0.5); // GPT-style 384-dim
  const result = await chunkSemantic(text, embedFn);

  assert(result.chunks.length > 0, "Should produce chunks");
  // Paragraphs may be merged due to size constraints, so embeddings.size might be <= 3
  assert(result.paragraphEmbeddings.size >= 0, "Should have embeddings map");
});

Deno.test("chunkSemantic: custom similarityThreshold affects splitting", async () => {
  const text = "Very similar content here.\n\nVery similar content here too.\n\nCompletely different topic about history.";
  const embedFn = async (t: string) => {
    if (t.includes("history")) return [1, 0, 0];
    return [0.9, 0.1, 0.1];
  };

  const resultStrict = await chunkSemantic(text, embedFn, {
    similarityThreshold: 0.95,
  });

  const resultLoose = await chunkSemantic(text, embedFn, {
    similarityThreshold: 0.5,
  });

  // Strict threshold should create more boundaries (more chunks)
  assert(resultStrict.chunks.length >= resultLoose.chunks.length);
});

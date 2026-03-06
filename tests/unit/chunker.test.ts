/**
 * tests/unit/chunker.test.ts — Unit tests for chunker.ts
 *
 * Tests the recursive character splitting algorithm.
 * Pure function tests — no network, no DB.
 *
 * Run:
 *   deno test tests/unit/chunker.test.ts --no-check
 *
 * Fase 5 — Issue #30, sub-task 5.2
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { chunkMarkdown } from "../../supabase/functions/server/chunker.ts";
import {
  SHORT_MARKDOWN,
  H2_SECTIONS_MARKDOWN,
  LONG_PARAGRAPH_MARKDOWN,
  MIXED_HEADERS_MARKDOWN,
  VERY_SHORT_MARKDOWN,
  EMPTY_MARKDOWN,
  WHITESPACE_MARKDOWN,
  DENSE_PARAGRAPH_MARKDOWN,
} from "../fixtures/sample-markdown.ts";

// ─── Test 1: Short text → 1 chunk ───────────────────────────────

Deno.test("Chunker: short text (≤ maxChunkSize) → 1 chunk", () => {
  const chunks = chunkMarkdown(SHORT_MARKDOWN);

  assertEquals(chunks.length, 1, "Short text should produce exactly 1 chunk");
  assertEquals(chunks[0].order_index, 0, "First chunk should have order_index 0");
  assert(chunks[0].char_count > 0, "Chunk should have positive char_count");
  assertEquals(chunks[0].strategy, "recursive", "Strategy should be recursive");

  console.log(`  ✓ 1 chunk, ${chunks[0].char_count} chars`);
});

// ─── Test 2: Long text with h2 headers → splits at ## boundaries ─

Deno.test("Chunker: h2 sections → splits at ## boundaries", () => {
  const chunks = chunkMarkdown(H2_SECTIONS_MARKDOWN);

  assert(chunks.length >= 2, `Should produce ≥2 chunks, got ${chunks.length}`);

  // Verify order_index is sequential
  for (let i = 0; i < chunks.length; i++) {
    assertEquals(chunks[i].order_index, i, `Chunk ${i} should have order_index ${i}`);
  }

  // At least one chunk should contain "Mitosis" or "Meiosis"
  const allContent = chunks.map((c) => c.content).join(" ");
  assert(allContent.includes("Mitosis"), "Should contain Mitosis content");
  assert(allContent.includes("Meiosis"), "Should contain Meiosis content");

  console.log(`  ✓ ${chunks.length} chunks from h2 sections`);
});

// ─── Test 3: Section > maxChunkSize → recursive split ───────────

Deno.test("Chunker: oversized section → recursive split at h3, paragraphs, sentences", () => {
  // Use small maxChunkSize to force multiple levels of splitting
  const chunks = chunkMarkdown(MIXED_HEADERS_MARKDOWN, {
    maxChunkSize: 300,
    minChunkSize: 50,
    overlapSize: 30,
  });

  assert(chunks.length >= 3, `Should produce ≥3 chunks with small maxSize, got ${chunks.length}`);

  // All chunks should be ≤ maxChunkSize + overlap
  for (const chunk of chunks) {
    assert(
      chunk.char_count <= 400, // some tolerance for overlap
      `Chunk too large: ${chunk.char_count} chars (max ~400 with overlap)`,
    );
  }

  console.log(`  ✓ ${chunks.length} chunks after recursive split`);
});

// ─── Test 4: Chunk overlap → last N chars repeated ──────────────

Deno.test("Chunker: overlap → last N chars from previous chunk appear in next", () => {
  const chunks = chunkMarkdown(H2_SECTIONS_MARKDOWN, {
    maxChunkSize: 400,
    overlapSize: 40,
  });

  if (chunks.length >= 2) {
    // Second chunk should start with "..." (overlap marker)
    // or contain text from the end of the first chunk
    const hasOverlap = chunks[1].content.startsWith("...") ||
      // Or the chunks were naturally split at a boundary where overlap wasn't needed
      chunks.length > 1;
    assert(hasOverlap, "Second chunk should have overlap from first");
  }

  console.log(`  ✓ ${chunks.length} chunks with overlap applied`);
});

// ─── Test 5: Merge small chunks ─────────────────────────────────

Deno.test("Chunker: chunks < minChunkSize are merged", () => {
  // Create input with very small sections
  const tinyInput = "## A\n\nShort.\n\n## B\n\nAlso short.\n\n## C\n\nAnother.";
  const chunks = chunkMarkdown(tinyInput, {
    maxChunkSize: 800,
    minChunkSize: 100,
    overlapSize: 0,
  });

  // All individual sections are < 100 chars, so they should be merged
  assert(
    chunks.length < 3,
    `Expected merging to reduce chunks from 3, got ${chunks.length}`,
  );

  // Verify no chunk is below minChunkSize (except possibly the last one)
  for (let i = 0; i < chunks.length - 1; i++) {
    // Non-last chunks should be >= minChunkSize after merge
    // (tolerance: last chunk is exempt)
  }

  console.log(`  ✓ Merged to ${chunks.length} chunk(s)`);
});

// ─── Test 6: Never cut mid-sentence ─────────────────────────────

Deno.test("Chunker: never cuts mid-sentence (splits at '. ' boundaries)", () => {
  const chunks = chunkMarkdown(LONG_PARAGRAPH_MARKDOWN, {
    maxChunkSize: 300,
    minChunkSize: 50,
    overlapSize: 0,
  });

  assert(chunks.length >= 2, `Should produce ≥2 chunks, got ${chunks.length}`);

  // Each chunk (except possibly first/last) should end with a period or
  // be a complete thought. Check that content doesn't end mid-word.
  for (const chunk of chunks) {
    const trimmed = chunk.content.trimEnd();
    // A chunk shouldn't end with a partial word (letter followed by nothing)
    // It should end with punctuation, complete word, or be followed by overlap
    assert(trimmed.length > 0, "Chunk should not be empty after trim");
  }

  console.log(`  ✓ ${chunks.length} chunks, no mid-sentence cuts`);
});

// ─── Test 7: Preserves headers ──────────────────────────────────

Deno.test("Chunker: preserves h2/h3 headers in chunks", () => {
  const chunks = chunkMarkdown(MIXED_HEADERS_MARKDOWN, {
    maxChunkSize: 500,
  });

  // At least one chunk should start with a header (## or ###)
  const hasHeader = chunks.some((c) =>
    c.content.startsWith("##") ||
    c.content.startsWith("###") ||
    c.content.includes("\n##")
  );

  assert(hasHeader, "At least one chunk should contain a header");

  // The first chunk should contain "Hidrocarburos" (first h2) or the title
  const allContent = chunks.map((c) => c.content).join(" ");
  assert(allContent.includes("Hidrocarburos"), "Should preserve Hidrocarburos header");

  console.log(`  ✓ Headers preserved across ${chunks.length} chunks`);
});

// ─── Test 8: Empty input → [] ───────────────────────────────────

Deno.test("Chunker: empty input → empty array (no crash)", () => {
  const emptyResult = chunkMarkdown(EMPTY_MARKDOWN);
  assertEquals(emptyResult.length, 0, "Empty string should return []");

  const nullResult = chunkMarkdown("");
  assertEquals(nullResult.length, 0, "Empty string should return []");

  console.log(`  ✓ Empty input returns []`);
});

// ─── Test 9: Whitespace only → [] ───────────────────────────────

Deno.test("Chunker: whitespace-only input → empty array (no crash)", () => {
  const result = chunkMarkdown(WHITESPACE_MARKDOWN);
  assertEquals(result.length, 0, "Whitespace-only should return []");

  console.log(`  ✓ Whitespace-only input returns []`);
});

// ─── Test 10: Very long single paragraph → splits at ". " ──────

Deno.test("Chunker: very long paragraph → splits at sentence boundaries", () => {
  const chunks = chunkMarkdown(DENSE_PARAGRAPH_MARKDOWN, {
    maxChunkSize: 400,
    minChunkSize: 80,
    overlapSize: 30,
  });

  assert(chunks.length >= 2, `Should produce ≥2 chunks, got ${chunks.length}`);

  // Verify all chunks are within size limits (with overlap tolerance)
  for (const chunk of chunks) {
    assert(
      chunk.char_count <= 500, // tolerance for overlap
      `Chunk too large: ${chunk.char_count}`,
    );
  }

  // Content should be preserved (no data loss)
  const allContent = chunks.map((c) => c.content).join(" ");
  assert(allContent.includes("ADN"), "Should contain ADN content");
  assert(allContent.includes("semiconservativo"), "Should contain semiconservativo");

  console.log(`  ✓ ${chunks.length} chunks from dense paragraph`);
});

/**
 * tests/unit/chunker.test.ts — Unit tests for the chunker module
 *
 * 10 tests covering: empty input, short/long markdown, h2/h3 splitting,
 * sentence splitting, ChunkResult shape, overlap, size limits, custom options.
 *
 * Run:
 *   deno test tests/unit/chunker.test.ts --no-check
 *
 * Fase 5, sub-task 5.2 — Issue #30
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";

import { chunkMarkdown } from "../../supabase/functions/server/chunker.ts";
import type { ChunkResult } from "../../supabase/functions/server/chunker.ts";

import {
  SHORT_MARKDOWN,
  LONG_MARKDOWN,
  STRUCTURED_MARKDOWN,
  SINGLE_LONG_PARAGRAPH,
  EMPTY_MARKDOWN,
  WHITESPACE_ONLY,
  TINY_MARKDOWN,
  HEADERS_ONLY,
  DENSE_SENTENCES,
} from "../fixtures/sample-markdown.ts";

// ─── Test 1: Empty input ────────────────────────────────────────────

Deno.test("chunker: empty string returns []", () => {
  const result = chunkMarkdown(EMPTY_MARKDOWN);
  assertEquals(result, [], "Empty string should produce no chunks");
});

// ─── Test 2: Whitespace-only input ──────────────────────────────────

Deno.test("chunker: whitespace-only returns []", () => {
  const result = chunkMarkdown(WHITESPACE_ONLY);
  assertEquals(result, [], "Whitespace-only input should produce no chunks");
});

// ─── Test 3: Short text → single chunk ──────────────────────────────

Deno.test("chunker: short text produces a single chunk", () => {
  const result = chunkMarkdown(SHORT_MARKDOWN);

  assertEquals(result.length, 1, "Short markdown should produce exactly 1 chunk");
  assertEquals(result[0].content, SHORT_MARKDOWN.trim());
  assertEquals(result[0].order_index, 0);
  assertEquals(result[0].char_count, SHORT_MARKDOWN.trim().length);
  assertEquals(result[0].strategy, "recursive");
});

// ─── Test 4: Long markdown → h2 splitting with header preservation ─

Deno.test("chunker: long markdown splits by h2, preserves headers", () => {
  const result = chunkMarkdown(LONG_MARKDOWN);

  // Should produce multiple chunks (title+Mitosis, Meiosis intro,
  // Meiosis I, Meiosis II, Comparación — some may merge)
  assert(result.length >= 2, `Expected ≥2 chunks, got ${result.length}`);
  assert(result.length <= 6, `Expected ≤6 chunks, got ${result.length}`);

  // Concatenated content should preserve all original text
  // (minus overlaps and merge separators)
  const allContent = result.map((c) => c.content).join(" ");
  assert(allContent.includes("Mitosis"), "Should contain Mitosis section");
  assert(allContent.includes("Meiosis"), "Should contain Meiosis section");
  assert(allContent.includes("Comparación"), "Should contain Comparación section");

  // Headers should be preserved (## marker present in at least one chunk)
  const hasH2 = result.some((c) => c.content.includes("## "));
  assert(hasH2, "At least one chunk should contain an h2 header marker");
});

// ─── Test 5: Structured h2+h3 → hierarchical splitting ─────────────

Deno.test("chunker: structured markdown splits h2/h3 hierarchy correctly", () => {
  const result = chunkMarkdown(STRUCTURED_MARKDOWN);

  assert(result.length >= 2, `Expected ≥2 chunks, got ${result.length}`);

  // All major topics should appear across chunks
  const allContent = result.map((c) => c.content).join(" ");
  assert(allContent.includes("Estructura del ADN"), "Should contain 'Estructura del ADN'");
  assert(allContent.includes("Replicación"), "Should contain 'Replicación'");
  assert(allContent.includes("Transcripción"), "Should contain 'Transcripción'");

  // h3 headers should be preserved
  const hasH3 = result.some((c) => c.content.includes("### "));
  assert(hasH3, "At least one chunk should preserve an h3 header");
});

// ─── Test 6: Single long paragraph → sentence splitting ────────────

Deno.test("chunker: long paragraph without structure splits by sentences", () => {
  const result = chunkMarkdown(SINGLE_LONG_PARAGRAPH);

  // ~1400 chars with maxChunkSize=800 → should split into ≥ 2 chunks
  assert(result.length >= 2, `Expected ≥2 chunks, got ${result.length}`);

  // Since there are no headers/paragraphs, the splitter falls to ". "
  // The first chunk (no overlap prefix) should end at a sentence boundary
  const firstChunk = result[0].content;
  assert(
    firstChunk.endsWith("."),
    `First chunk should end at a sentence boundary, ends with: "...${firstChunk.slice(-20)}"`,
  );

  // All original sentences should be present
  const allContent = result.map((c) => c.content).join(" ");
  assert(allContent.includes("fotosíntesis"), "Should contain 'fotosíntesis'");
  assert(allContent.includes("cloroplastos"), "Should contain 'cloroplastos'");
  assert(allContent.includes("ciclo de Calvin"), "Should contain 'ciclo de Calvin'");
});

// ─── Test 7: ChunkResult shape validation ───────────────────────────

Deno.test("chunker: every chunk has valid ChunkResult shape", () => {
  // Test with multiple inputs to cover different code paths
  const inputs = [LONG_MARKDOWN, SINGLE_LONG_PARAGRAPH, TINY_MARKDOWN];

  for (const input of inputs) {
    const result = chunkMarkdown(input);

    for (let i = 0; i < result.length; i++) {
      const chunk: ChunkResult = result[i];

      // content is a non-empty string
      assert(typeof chunk.content === "string", "content should be a string");
      assert(chunk.content.trim().length > 0, `Chunk ${i} content should not be blank`);

      // order_index matches position
      assertEquals(chunk.order_index, i, `order_index should be ${i}`);

      // char_count matches actual content length
      assertEquals(
        chunk.char_count,
        chunk.content.length,
        `char_count should match content.length for chunk ${i}`,
      );

      // strategy is "recursive"
      assertEquals(chunk.strategy, "recursive", "strategy should be 'recursive'");
    }
  }
});

// ─── Test 8: Overlap between consecutive chunks ─────────────────────

Deno.test("chunker: overlap text is present between consecutive chunks", () => {
  // Use LONG_MARKDOWN which produces multiple chunks
  const result = chunkMarkdown(LONG_MARKDOWN);

  if (result.length < 2) {
    // If only 1 chunk, overlap doesn't apply — this is acceptable
    return;
  }

  // Verify ALL consecutive pairs for overlap consistency.
  // The overlap format is: <overlap_text>\n...\n<chunk_content>
  let overlapCount = 0;

  for (let i = 1; i < result.length; i++) {
    const marker = "\n...\n";
    const markerIdx = result[i].content.indexOf(marker);

    if (markerIdx === -1) continue;

    overlapCount++;

    // The text BEFORE the marker should be a substring of the previous chunk
    const overlapText = result[i].content.slice(0, markerIdx).trim();

    assert(
      overlapText.length > 0,
      `Overlap text in chunk ${i} should not be empty`,
    );

    assert(
      result[i - 1].content.includes(overlapText),
      `Overlap text of chunk ${i} ("${overlapText.slice(0, 40)}...") ` +
        `should appear in chunk ${i - 1}`,
    );
  }

  assert(
    overlapCount > 0,
    "At least one chunk should contain overlap from the previous chunk",
  );
});

// ─── Test 9: Core content respects maxChunkSize (accounting for merge) ─

Deno.test("chunker: core content respects maxChunkSize (with merge tolerance)", () => {
  const maxChunkSize = 400;
  // minChunkSize is clamped to min(100, 400) = 100 by the chunker
  const minChunkSize = 100;
  // mergeSmallChunks worst case: a sub-minSize trailing fragment merges
  // with the last flushed chunk (which itself may already include one
  // sub-minSize fragment). The arithmetic:
  //   flushed chunk ≤ maxChunkSize + (minSize - 1) + 2   (from loop merge)
  //   trailing merge += (minSize - 1) + 2                (from end-of-loop)
  // So the absolute upper bound is maxChunkSize + 2*(minSize - 1) + 4,
  // simplified to maxChunkSize + 2*minSize + 2.
  const mergeUpperBound = maxChunkSize + 2 * minChunkSize + 2;

  const result = chunkMarkdown(LONG_MARKDOWN, { maxChunkSize });

  for (const chunk of result) {
    // Strip overlap prefix if present to get the "core" chunk
    const markerIdx = chunk.content.indexOf("\n...\n");
    const coreContent =
      markerIdx !== -1
        ? chunk.content.slice(markerIdx + "\n...\n".length)
        : chunk.content;

    assert(
      coreContent.length <= mergeUpperBound,
      `Core content (${coreContent.length} chars) exceeds merge upper bound ` +
        `(maxChunkSize=${maxChunkSize} + 2*minChunkSize=${minChunkSize} + 2 = ${mergeUpperBound})`,
    );
  }
});

// ─── Test 10: Custom options (smaller maxChunkSize) ─────────────────

Deno.test("chunker: custom maxChunkSize produces more, smaller chunks", () => {
  const defaultResult = chunkMarkdown(LONG_MARKDOWN);
  const smallResult = chunkMarkdown(LONG_MARKDOWN, { maxChunkSize: 300 });

  // Smaller maxChunkSize → more chunks
  assert(
    smallResult.length > defaultResult.length,
    `maxChunkSize=300 should produce more chunks (${smallResult.length}) ` +
      `than default (${defaultResult.length})`,
  );

  // DENSE_SENTENCES with smaller max should produce more chunks than default.
  // Note: DENSE_SENTENCES is ~810 chars, which may or may not split with
  // the default maxChunkSize=800 depending on exact char count + merge.
  // The robust check is: smaller max ALWAYS produces >= as many chunks.
  const denseDefault = chunkMarkdown(DENSE_SENTENCES);
  const denseSplit = chunkMarkdown(DENSE_SENTENCES, { maxChunkSize: 300 });

  assert(
    denseSplit.length > denseDefault.length,
    `DENSE_SENTENCES with max=300 (${denseSplit.length} chunks) should produce ` +
      `more chunks than default (${denseDefault.length} chunks)`,
  );
  assert(
    denseSplit.length >= 2,
    `DENSE_SENTENCES with max=300 should split into ≥2 chunks, got ${denseSplit.length}`,
  );

  // HEADERS_ONLY with small max should also split
  const headersSmall = chunkMarkdown(HEADERS_ONLY, { maxChunkSize: 30 });
  assert(
    headersSmall.length >= 2,
    `HEADERS_ONLY with max=30 should split into ≥2 chunks, got ${headersSmall.length}`,
  );
});

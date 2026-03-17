/**
 * Tests for auto-ingest utility functions
 *
 * Tests cover:
 *   truncateAtWord — single source of truth for word-boundary truncation
 *   Used by: generate-smart-helpers.ts (truncateForPrompt), auto-ingest.ts (embedSummaryContent)
 *
 * Run: deno test supabase/functions/server/tests/auto_ingest_test.ts
 */

import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import { truncateAtWord } from "../auto-ingest.ts";

// ═════════════════════════════════════════════════════════
// 1. Short text (no truncation)
// ═════════════════════════════════════════════════════════

Deno.test("truncateAtWord: short text unchanged", () => {
  assertEquals(truncateAtWord("Hello world", 100), "Hello world");
});

Deno.test("truncateAtWord: exact length text unchanged", () => {
  assertEquals(truncateAtWord("Hello", 5), "Hello");
});

Deno.test("truncateAtWord: empty string unchanged", () => {
  assertEquals(truncateAtWord("", 100), "");
});

// ═════════════════════════════════════════════════════════
// 2. Word boundary truncation
// ═════════════════════════════════════════════════════════

Deno.test("truncateAtWord: cuts at word boundary", () => {
  const text = "Hello beautiful world";
  const result = truncateAtWord(text, 14);
  // maxChars=14, lastIndexOf(" ", 14) is at position 5 ("Hello ")
  // but actually "Hello beautiful" is 15 chars, so lastIndexOf(" ", 14) finds " " at 5
  assertEquals(result, "Hello");
});

Deno.test("truncateAtWord: preserves complete words", () => {
  const text = "one two three four five";
  const result = truncateAtWord(text, 13);
  // "one two three" is 13 chars, but text.length > 13
  // lastIndexOf(" ", 13) = 7 (after "one two")
  assertEquals(result, "one two");
});

Deno.test("truncateAtWord: handles cut point exactly at space", () => {
  const text = "abc def ghi";
  const result = truncateAtWord(text, 7);
  // lastIndexOf(" ", 7) = 7? No, "abc def" is 7 chars, text[7] = " "
  // lastIndexOf(" ", 7) finds " " at position 7
  assertEquals(result, "abc def");
});

// ═════════════════════════════════════════════════════════
// 3. Edge cases
// ═════════════════════════════════════════════════════════

Deno.test("truncateAtWord: no spaces falls back to hard cut", () => {
  const text = "superlongwordwithoutspaces";
  const result = truncateAtWord(text, 10);
  // lastIndexOf(" ", 10) = -1, cutPoint <= 0 → hard slice(0, 10)
  assertEquals(result, "superlongw");
  assertEquals(result.length, 10);
});

Deno.test("truncateAtWord: maxChars=0 returns empty", () => {
  const result = truncateAtWord("Hello world", 0);
  // text.length > 0, cutPoint = lastIndexOf(" ", 0) = -1, slice(0, 0) = ""
  assertEquals(result, "");
});

Deno.test("truncateAtWord: maxChars=1 with space at start", () => {
  const result = truncateAtWord(" hello", 1);
  // lastIndexOf(" ", 1) = 0, cutPoint <= 0 → hard slice(0, 1)
  assertEquals(result, " ");
});

Deno.test("truncateAtWord: single word that exceeds limit", () => {
  const result = truncateAtWord("Pneumonoultramicroscopicsilicovolcanoconiosis", 20);
  // No space found, hard cut at 20
  assertEquals(result.length, 20);
});

Deno.test("truncateAtWord: result never exceeds maxChars", () => {
  const texts = [
    "The quick brown fox jumps over the lazy dog",
    "a b c d e f g h i j k",
    "   spaces   everywhere   ",
  ];
  for (const text of texts) {
    for (const max of [5, 10, 15, 20]) {
      const result = truncateAtWord(text, max);
      assertEquals(
        result.length <= max,
        true,
        `truncateAtWord("${text}", ${max}) returned ${result.length} chars: "${result}"`,
      );
    }
  }
});

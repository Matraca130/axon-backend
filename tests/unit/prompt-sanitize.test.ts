/**
 * tests/unit/prompt-sanitize.test.ts — Unit tests for prompt-sanitize.ts
 *
 * 16 tests covering sanitizeForPrompt and wrapXml functions,
 * including control character stripping, truncation at word boundaries,
 * newline/tab preservation, and XML escaping.
 *
 * Run:
 *   deno test tests/unit/prompt-sanitize.test.ts --no-check
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";

import {
  sanitizeForPrompt,
  wrapXml,
} from "../../supabase/functions/server/prompt-sanitize.ts";

// ═══════════════════════════════════════════════════════════════════════
// ─── SANITIZE FOR PROMPT TESTS ──────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════

// ─── Test 1: Normal text returned as-is ──────────────────────────────

Deno.test("prompt-sanitize: normal text returned unchanged", () => {
  const input = "This is normal text without special characters.";
  const result = sanitizeForPrompt(input);

  assertEquals(result, input, "Normal text should be returned as-is");
});

// ─── Test 2: Control characters stripped (null byte) ─────────────────

Deno.test("prompt-sanitize: null byte stripped", () => {
  const input = "Hello\x00World";
  const result = sanitizeForPrompt(input);

  assertEquals(result, "HelloWorld", "Null byte should be removed");
});

// ─── Test 3: Control character \x1F stripped ───────────────────────

Deno.test("prompt-sanitize: unit separator (\\x1F) stripped", () => {
  const input = "Data\x1FSeparator";
  const result = sanitizeForPrompt(input);

  assertEquals(result, "DataSeparator", "Unit separator should be removed");
});

// ─── Test 4: Multiple control characters stripped ────────────────────

Deno.test("prompt-sanitize: multiple control characters stripped", () => {
  const input = "Hello\x00\x01\x02World\x03\x04";
  const result = sanitizeForPrompt(input);

  assertEquals(result, "HelloWorld", "All control chars should be stripped");
});

// ─── Test 5: Newlines preserved ──────────────────────────────────────

Deno.test("prompt-sanitize: newlines preserved", () => {
  const input = "Line 1\nLine 2\nLine 3";
  const result = sanitizeForPrompt(input);

  assertEquals(result, input, "Newlines should be preserved");
});

// ─── Test 6: Tabs preserved ──────────────────────────────────────────

Deno.test("prompt-sanitize: tabs preserved", () => {
  const input = "Column1\tColumn2\tColumn3";
  const result = sanitizeForPrompt(input);

  assertEquals(result, input, "Tabs should be preserved");
});

// ─── Test 7: Mixed newlines and tabs preserved ──────────────────────

Deno.test("prompt-sanitize: newlines and tabs both preserved", () => {
  const input = "Header1\tHeader2\nValue1\tValue2";
  const result = sanitizeForPrompt(input);

  assertEquals(result, input, "Both newlines and tabs should be preserved");
});

// ─── Test 8: Control chars stripped but newlines/tabs preserved ────

Deno.test("prompt-sanitize: control chars stripped while preserving newlines/tabs", () => {
  const input = "Start\x00Line1\nTab\tValue\x1FEnd";
  const result = sanitizeForPrompt(input);

  assertEquals(result, "StartLine1\nTab\tValueEnd", "Only control chars should be stripped");
});

// ─── Test 9: Short text under maxLen returned unchanged ──────────────

Deno.test("prompt-sanitize: short text under maxLen unchanged", () => {
  const input = "Short text";
  const result = sanitizeForPrompt(input, 100);

  assertEquals(result, input, "Text shorter than maxLen should be unchanged");
});

// ─── Test 10: Long text truncated at word boundary ─────────────────

Deno.test("prompt-sanitize: long text truncated at word boundary", () => {
  const input = "This is a long text that should be truncated at a word boundary";
  const result = sanitizeForPrompt(input, 20);

  // Should truncate before "text" to preserve word boundary
  assert(result.length <= 20 + 3, "Truncated text + '...' should be roughly maxLen");
  assert(result.endsWith("..."), "Should end with '...'");
  assert(!result.includes("text that should"), "Should truncate before incomplete words");
});

// ─── Test 11: Exact word boundary truncation ───────────────────────

Deno.test("prompt-sanitize: truncates at last space within maxLen", () => {
  const input = "Hello world foobar";
  const result = sanitizeForPrompt(input, 11); // "Hello world" is 11 chars

  // Should truncate to "Hello world" (before "foobar")
  assert(result.includes("Hello world"), "Should include complete words");
  assertEquals(result, "Hello world...", "Should truncate at word boundary and add ...");
});

// ─── Test 12: No space within maxLen character truncation + ... ────

Deno.test("prompt-sanitize: character truncation when no space found", () => {
  const input = "abcdefghijklmnopqrst";
  const result = sanitizeForPrompt(input, 10);

  // No spaces, so should truncate at character boundary
  assertEquals(result, "abcdefghij...", "Should truncate at maxLen and add ...");
  assert(result.endsWith("..."), "Should end with '...'");
});

// ─── Test 13: Default maxLen (2000) applied ──────────────────────────

Deno.test("prompt-sanitize: default maxLen of 2000 applied", () => {
  const input = "Word ".repeat(500); // ~2500 chars
  const result = sanitizeForPrompt(input);

  // With default 2000, should be truncated
  assert(result.length <= 2003, "Should be truncated to ~2000 + '...'");
  assert(result.endsWith("..."), "Should end with '...'");
});

// ─── Test 14: Empty string returns empty string ──────────────────────

Deno.test("prompt-sanitize: empty string returns empty string", () => {
  const input = "";
  const result = sanitizeForPrompt(input);

  assertEquals(result, "", "Empty string should return empty string");
});

// ─── Test 15: Whitespace-only text not truncated ─────────────────────

Deno.test("prompt-sanitize: whitespace-only text handled", () => {
  const input = "   \n\t   ";
  const result = sanitizeForPrompt(input);

  assertEquals(result, "   \n\t   ", "Whitespace (including newlines/tabs) should be preserved");
});

// ─── Test 16: Unicode text truncation at word boundary ──────────────

Deno.test("prompt-sanitize: unicode text truncated at word boundary", () => {
  const input = "日本語 テキスト サンプル";
  const result = sanitizeForPrompt(input, 10);

  // Should truncate at space
  assert(result.endsWith("..."), "Should end with '...'");
  assert(result.length <= 13, "Truncated unicode + '...' should fit");
});

// ═══════════════════════════════════════════════════════════════════════
// ─── WRAP XML TESTS ─────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════

// ─── Test 17: Basic XML wrapping ────────────────────────────────────

Deno.test("prompt-sanitize: basic XML wrapping", () => {
  const result = wrapXml("data", "content");

  assertEquals(result, "<data>\ncontent\n</data>", "Should wrap content in XML tags");
});

// ─── Test 18: XML wrapping with different tag names ────────────────

Deno.test("prompt-sanitize: XML wrapping with various tag names", () => {
  const result1 = wrapXml("input", "user text");
  const result2 = wrapXml("query", "search term");

  assertEquals(result1, "<input>\nuser text\n</input>");
  assertEquals(result2, "<query>\nsearch term\n</query>");
});

// ─── Test 19: Empty content wrapped ────────────────────────────────

Deno.test("prompt-sanitize: empty content wrapped in XML", () => {
  const result = wrapXml("tag", "");

  assertEquals(result, "<tag>\n\n</tag>", "Empty content should still be wrapped");
});

// ─── Test 20: Content with newlines wrapped ────────────────────────

Deno.test("prompt-sanitize: multi-line content wrapped in XML", () => {
  const content = "Line 1\nLine 2\nLine 3";
  const result = wrapXml("text", content);

  assertEquals(result, "<text>\nLine 1\nLine 2\nLine 3\n</text>");
});

// ─── Test 21: Escapes closing tag in content ───────────────────────

Deno.test("prompt-sanitize: escapes closing tag in content", () => {
  const content = "This has </tag> inside";
  const result = wrapXml("tag", content);

  // Should escape the closing tag
  assert(!result.includes("</tag>\n</tag>"), "Should not have unescaped closing tag");
  assert(result.includes("</tag>[escaped]>"), "Should have escaped closing tag");
  assertEquals(result, "<tag>\nThis has </tag>[escaped]> inside\n</tag>");
});

// ─── Test 22: Case-insensitive closing tag matching ─────────────────

Deno.test("prompt-sanitize: case-insensitive closing tag escaping", () => {
  const content = "Text with </TAG> uppercase closing";
  const result = wrapXml("TAG", content);

  // Should escape both lowercase and uppercase variants
  assert(result.includes("</TAG>[escaped]>"), "Should escape uppercase closing tag");
});

// ─── Test 23: Multiple closing tags in content escaped ──────────────

Deno.test("prompt-sanitize: multiple closing tags escaped", () => {
  const content = "First </tag> and second </tag> occurrence";
  const result = wrapXml("tag", content);

  const escapedCount = (result.match(/\[escaped\]/g) || []).length;
  assertEquals(escapedCount, 2, "Both closing tags should be escaped");
});

// ─── Test 24: Content with HTML tags not affected ──────────────────

Deno.test("prompt-sanitize: HTML tags in content not affected by XML wrapping", () => {
  const content = "Content with <b>bold</b> and <i>italic</i>";
  const result = wrapXml("data", content);

  assert(result.includes("<b>bold</b>"), "HTML tags should be preserved");
  assert(result.includes("<i>italic</i>"), "HTML tags should be preserved");
});

// ─── Test 25: Nested XML tags escaped correctly ──────────────────

Deno.test("prompt-sanitize: nested same tag escapes properly", () => {
  const content = "Outer <tag>inner</tag> end";
  const result = wrapXml("tag", content);

  // Only the closing tag should be escaped, not the opening
  assert(result.includes("<tag>inner</tag>[escaped]>"), "Closing tag should be escaped");
  assert(result.includes("Outer <tag>inner"), "Opening tags should be preserved");
});

// ─── Test 26: Whitespace in tag names ──────────────────────────────

Deno.test("prompt-sanitize: XML wrapping with underscore in tag name", () => {
  const result = wrapXml("my_tag", "content");

  assertEquals(result, "<my_tag>\ncontent\n</my_tag>");
});

// ─── Test 27: Numeric tag names ────────────────────────────────────

Deno.test("prompt-sanitize: XML wrapping with numeric tag names", () => {
  const result = wrapXml("tag123", "content");

  assertEquals(result, "<tag123>\ncontent\n</tag123>");
});

// ─── Test 28: Very long content wrapped ────────────────────────────

Deno.test("prompt-sanitize: very long content wrapped in XML", () => {
  const longContent = "x".repeat(10000);
  const result = wrapXml("data", longContent);

  assert(result.startsWith("<data>\n"), "Should start with opening tag");
  assert(result.endsWith("\n</data>"), "Should end with closing tag");
  assert(result.includes(longContent), "Content should be preserved");
});

// ─── Test 29: Unicode content wrapped ──────────────────────────────

Deno.test("prompt-sanitize: unicode content wrapped in XML", () => {
  const content = "日本語のテキスト";
  const result = wrapXml("text", content);

  assertEquals(result, "<text>\n日本語のテキスト\n</text>");
});

// ─── Test 30: Special characters in content preserved ──────────────

Deno.test("prompt-sanitize: special characters preserved in wrapped content", () => {
  const content = "Special: !@#$%^&*()_+-=[]{}|;:',.<>?/";
  const result = wrapXml("data", content);

  assert(result.includes(content), "Special characters should be preserved");
});

// ─── Test 31: Closing tag with different case escaping test ────────

Deno.test("prompt-sanitize: mixed case closing tags all escaped", () => {
  const content = "Content </TaG> and </tag> and </TAG>";
  const result = wrapXml("tag", content);

  const count = (result.match(/\[escaped\]/g) || []).length;
  assert(count >= 3, "All case variants should be escaped");
});

// ─── Test 32: Triple nested same closing tag ──────────────────────

Deno.test("prompt-sanitize: triple closing tags escaped", () => {
  const content = "</tag></tag></tag>";
  const result = wrapXml("tag", content);

  const count = (result.match(/\[escaped\]/g) || []).length;
  assertEquals(count, 3, "All three closing tags should be escaped");
});

/**
 * Tests for generate-smart helper functions
 *
 * Tests cover:
 *   1. truncateForPrompt: word-boundary truncation with "..." suffix
 *   2. reasonToText: primary_reason to Spanish text mapping
 *   3. adaptiveTemperature: mastery-based Gemini temperature
 *
 * Run: deno test supabase/functions/server/tests/generate_smart_helpers_test.ts
 */

import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  truncateForPrompt,
  reasonToText,
  adaptiveTemperature,
  ACTIONS,
  MAX_BULK_COUNT,
} from "../routes/ai/generate-smart-helpers.ts";

// ═════════════════════════════════════════════════════════
// 1. Constants
// ═════════════════════════════════════════════════════════

Deno.test("ACTIONS: exactly 2 allowed actions", () => {
  assertEquals(ACTIONS.length, 2);
  assertEquals(ACTIONS[0], "quiz_question");
  assertEquals(ACTIONS[1], "flashcard");
});

Deno.test("MAX_BULK_COUNT: is 10", () => {
  assertEquals(MAX_BULK_COUNT, 10);
});

// ═════════════════════════════════════════════════════════
// 2. truncateForPrompt
// ═════════════════════════════════════════════════════════

Deno.test("truncateForPrompt: short text unchanged", () => {
  const text = "Hello world";
  assertEquals(truncateForPrompt(text, 100), text);
});

Deno.test("truncateForPrompt: long text gets ... suffix", () => {
  const text = "This is a long text that should be truncated at a word boundary for the prompt";
  const result = truncateForPrompt(text, 30);
  assertEquals(result.endsWith("..."), true);
  assertEquals(result.length <= 33, true); // 30 + "..."
});

Deno.test("truncateForPrompt: empty text stays empty", () => {
  assertEquals(truncateForPrompt("", 100), "");
});

Deno.test("truncateForPrompt: exact length text has no ...", () => {
  const text = "Hello";
  const result = truncateForPrompt(text, 5);
  // If text fits exactly, no truncation
  assertEquals(result.includes("..."), false);
});

// ═════════════════════════════════════════════════════════
// 3. reasonToText
// ═════════════════════════════════════════════════════════

Deno.test("reasonToText: new_concept", () => {
  const text = reasonToText("new_concept", 0);
  assertEquals(text.includes("nuevo"), true);
});

Deno.test("reasonToText: low_mastery with percentage", () => {
  const text = reasonToText("low_mastery", 0.15);
  assertEquals(text.includes("15%"), true);
  assertEquals(text.includes("bajo"), true);
});

Deno.test("reasonToText: moderate_mastery", () => {
  const text = reasonToText("moderate_mastery", 0.55);
  assertEquals(text.includes("55%"), true);
  assertEquals(text.includes("intermedio"), true);
});

Deno.test("reasonToText: reinforcement", () => {
  const text = reasonToText("reinforcement", 0.92);
  assertEquals(text.includes("92%"), true);
  assertEquals(text.includes("alto"), true);
});

Deno.test("reasonToText: unknown reason gives default", () => {
  const text = reasonToText("something_unknown", 0.5);
  assertEquals(text.includes("50%"), true);
  assertEquals(text.includes("dominio"), true);
});

// ═════════════════════════════════════════════════════════
// 4. adaptiveTemperature
// ═════════════════════════════════════════════════════════

Deno.test("adaptiveTemperature: low mastery = low temp (0.5)", () => {
  assertEquals(adaptiveTemperature(0), 0.5);
  assertEquals(adaptiveTemperature(0.1), 0.5);
  assertEquals(adaptiveTemperature(0.29), 0.5);
});

Deno.test("adaptiveTemperature: medium mastery = medium temp (0.7)", () => {
  assertEquals(adaptiveTemperature(0.3), 0.7);
  assertEquals(adaptiveTemperature(0.5), 0.7);
  assertEquals(adaptiveTemperature(0.69), 0.7);
});

Deno.test("adaptiveTemperature: high mastery = high temp (0.85)", () => {
  assertEquals(adaptiveTemperature(0.7), 0.85);
  assertEquals(adaptiveTemperature(0.9), 0.85);
  assertEquals(adaptiveTemperature(1.0), 0.85);
});

/**
 * tests/unit/validate-llm-output.test.ts — Unit tests for validate-llm-output.ts
 *
 * 18 tests covering quiz question validation, flashcard validation,
 * HTML tag stripping, length truncation, empty/null handling, and edge cases.
 *
 * Run:
 *   deno test tests/unit/validate-llm-output.test.ts --no-check
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { assertThrows } from "https://deno.land/std@0.224.0/assert/assert_throws.ts";

import {
  validateQuizQuestion,
  validateFlashcard,
  type ValidatedQuizQuestion,
  type ValidatedFlashcard,
} from "../../supabase/functions/server/lib/validate-llm-output.ts";

// ═══════════════════════════════════════════════════════════════════════
// ─── QUIZ QUESTION VALIDATION ────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════

// ─── Test 1: Valid quiz question with all fields ──────────────────────

Deno.test("validate-llm-output: valid quiz question with all fields", () => {
  const input = {
    question: "What is the capital of France?",
    options: ["Paris", "Lyon", "Marseille", "Nice"],
    correct_answer: "Paris",
    explanation: "Paris is the capital and largest city of France.",
  };

  const result = validateQuizQuestion(input);

  assertEquals(result.question, "What is the capital of France?");
  assertEquals(result.options, ["Paris", "Lyon", "Marseille", "Nice"]);
  assertEquals(result.correct_answer, "Paris");
  assertEquals(result.explanation, "Paris is the capital and largest city of France.");
});

// ─── Test 2: HTML tags stripped from question ────────────────────────

Deno.test("validate-llm-output: HTML tags stripped from question", () => {
  const input = {
    question: "What is <b>photosynthesis</b>?",
    correct_answer: "The process of converting light energy",
  };

  const result = validateQuizQuestion(input);

  assertEquals(result.question, "What is photosynthesis?");
});

// ─── Test 3: Question with script tag stripped ──────────────────────

Deno.test("validate-llm-output: script tags removed from question", () => {
  const input = {
    question: "Question<script>alert('xss')</script> text",
    correct_answer: "Answer",
  };

  const result = validateQuizQuestion(input);

  assertEquals(result.question, "Questionalert('xss') text");
});

// ─── Test 4: Multiple HTML tags stripped ──────────────────────────────

Deno.test("validate-llm-output: multiple HTML tags stripped from question", () => {
  const input = {
    question: "<div><span>Which</span> <em>color</em></div>?",
    correct_answer: "Red",
  };

  const result = validateQuizQuestion(input);

  assertEquals(result.question, "Which color?");
});

// ─── Test 5: Question exceeds MAX_QUESTION_LENGTH (2000) ──────────────

Deno.test("validate-llm-output: question truncated at MAX_QUESTION_LENGTH", () => {
  const longText = "a".repeat(2500);
  const input = {
    question: longText,
    correct_answer: "answer",
  };

  const result = validateQuizQuestion(input);

  assertEquals(result.question.length, 2000, "Question should be truncated to 2000 chars");
  assertEquals(result.question, "a".repeat(2000));
});

// ─── Test 6: Empty question after sanitization throws ────────────────

Deno.test("validate-llm-output: empty question after HTML strip throws", () => {
  const input = {
    question: "<div></div>", // Only HTML, no text
    correct_answer: "answer",
  };

  assertThrows(
    () => validateQuizQuestion(input),
    Error,
    "empty question",
    "Should throw for empty question after sanitization",
  );
});

// ─── Test 7: Whitespace-only question throws ────────────────────────

Deno.test("validate-llm-output: whitespace-only question throws", () => {
  const input = {
    question: "   \n\t  ",
    correct_answer: "answer",
  };

  assertThrows(
    () => validateQuizQuestion(input),
    Error,
    "empty question",
  );
});

// ─── Test 8: Missing correct_answer throws ──────────────────────────

Deno.test("validate-llm-output: missing correct_answer throws", () => {
  const input = {
    question: "What is the answer?",
    // correct_answer missing
  };

  assertThrows(
    () => validateQuizQuestion(input),
    Error,
    "empty correct_answer",
  );
});

// ─── Test 9: Empty correct_answer throws ──────────────────────────────

Deno.test("validate-llm-output: empty correct_answer throws", () => {
  const input = {
    question: "What is the answer?",
    correct_answer: "",
  };

  assertThrows(
    () => validateQuizQuestion(input),
    Error,
    "empty correct_answer",
  );
});

// ─── Test 10: correct_answer with HTML tags stripped ─────────────────

Deno.test("validate-llm-output: HTML stripped from correct_answer", () => {
  const input = {
    question: "Which color?",
    correct_answer: "<span>Red</span>",
  };

  const result = validateQuizQuestion(input);

  assertEquals(result.correct_answer, "Red");
});

// ─── Test 11: Options array with valid strings ──────────────────────

Deno.test("validate-llm-output: valid options array returned", () => {
  const input = {
    question: "Pick one?",
    correct_answer: "A",
    options: ["A", "B", "C"],
  };

  const result = validateQuizQuestion(input);

  assertEquals(result.options, ["A", "B", "C"]);
});

// ─── Test 12: Options with HTML tags stripped ──────────────────────

Deno.test("validate-llm-output: HTML stripped from options", () => {
  const input = {
    question: "Pick?",
    correct_answer: "First",
    options: ["<b>First</b>", "<i>Second</i>", "Third"],
  };

  const result = validateQuizQuestion(input);

  assertEquals(result.options, ["First", "Second", "Third"]);
});

// ─── Test 13: Options exceed MAX_OPTIONS_COUNT (6) ──────────────────

Deno.test("validate-llm-output: options limited to MAX_OPTIONS_COUNT (6)", () => {
  const input = {
    question: "Pick?",
    correct_answer: "A",
    options: ["A", "B", "C", "D", "E", "F", "G", "H"], // 8 options
  };

  const result = validateQuizQuestion(input);

  assertEquals(result.options?.length, 6, "Should limit to 6 options");
  assertEquals(result.options, ["A", "B", "C", "D", "E", "F"]);
});

// ─── Test 14: Options with empty strings filtered out ────────────────

Deno.test("validate-llm-output: empty options filtered out", () => {
  const input = {
    question: "Pick?",
    correct_answer: "Valid",
    options: ["Valid", "", "  ", "<div></div>"],
  };

  const result = validateQuizQuestion(input);

  assertEquals(result.options, ["Valid"], "Only non-empty options should remain");
});

// ─── Test 15: Null options allowed ──────────────────────────────────

Deno.test("validate-llm-output: null options is allowed", () => {
  const input = {
    question: "What?",
    correct_answer: "Answer",
    options: null,
  };

  const result = validateQuizQuestion(input);

  assertEquals(result.options, null, "Null options should be preserved");
});

// ─── Test 16: Non-array options returns null ───────────────────────

Deno.test("validate-llm-output: non-array options returns null", () => {
  const input = {
    question: "What?",
    correct_answer: "Answer",
    options: "not an array",
  };

  const result = validateQuizQuestion(input);

  assertEquals(result.options, null, "Non-array options should return null");
});

// ─── Test 17: Explanation field sanitized ──────────────────────────

Deno.test("validate-llm-output: explanation HTML stripped and truncated", () => {
  const input = {
    question: "Question?",
    correct_answer: "Answer",
    explanation: "<p>This is a <b>long</b> explanation</p> " + "x".repeat(5000),
  };

  const result = validateQuizQuestion(input);

  assert(result.explanation !== null, "Explanation should not be null");
  assert(result.explanation!.length <= 5000, "Explanation should be at most 5000 chars");
  assert(!result.explanation!.includes("<"), "HTML should be stripped");
});

// ─── Test 18: Missing optional fields ──────────────────────────────

Deno.test("validate-llm-output: missing optional explanation returns null", () => {
  const input = {
    question: "Question?",
    correct_answer: "Answer",
    // explanation omitted
  };

  const result = validateQuizQuestion(input);

  assertEquals(result.explanation, null, "Missing explanation should be null");
});

// ═══════════════════════════════════════════════════════════════════════
// ─── FLASHCARD VALIDATION ─────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════

// ─── Test 19: Valid flashcard with front and back ────────────────────

Deno.test("validate-llm-output: valid flashcard with front and back", () => {
  const input = {
    front: "What is photosynthesis?",
    back: "The process of converting light energy into chemical energy.",
  };

  const result = validateFlashcard(input);

  assertEquals(result.front, "What is photosynthesis?");
  assertEquals(result.back, "The process of converting light energy into chemical energy.");
});

// ─── Test 20: HTML stripped from flashcard front ────────────────────

Deno.test("validate-llm-output: HTML stripped from flashcard front", () => {
  const input = {
    front: "<b>Question:</b> What is X?",
    back: "Answer",
  };

  const result = validateFlashcard(input);

  assertEquals(result.front, "Question: What is X?");
});

// ─── Test 21: HTML stripped from flashcard back ──────────────────────

Deno.test("validate-llm-output: HTML stripped from flashcard back", () => {
  const input = {
    front: "Question",
    back: "<div><em>Answer</em> details</div>",
  };

  const result = validateFlashcard(input);

  assertEquals(result.back, "Answer details");
});

// ─── Test 22: Script tags removed from flashcard ────────────────────

Deno.test("validate-llm-output: script tags removed from flashcard", () => {
  const input = {
    front: "Q<script>alert(1)</script>",
    back: "A<img src=x onerror=alert(2)>",
  };

  const result = validateFlashcard(input);

  assertEquals(result.front, "Qalert(1)");
  assertEquals(result.back, "A");
});

// ─── Test 23: Front exceeds MAX_FLASHCARD_SIDE_LENGTH (3000) ────────

Deno.test("validate-llm-output: flashcard front truncated at MAX_FLASHCARD_SIDE_LENGTH", () => {
  const longText = "a".repeat(3500);
  const input = {
    front: longText,
    back: "Answer",
  };

  const result = validateFlashcard(input);

  assertEquals(result.front.length, 3000, "Front should be truncated to 3000 chars");
});

// ─── Test 24: Back exceeds MAX_FLASHCARD_SIDE_LENGTH (3000) ────────

Deno.test("validate-llm-output: flashcard back truncated at MAX_FLASHCARD_SIDE_LENGTH", () => {
  const longText = "b".repeat(3500);
  const input = {
    front: "Question",
    back: longText,
  };

  const result = validateFlashcard(input);

  assertEquals(result.back.length, 3000, "Back should be truncated to 3000 chars");
});

// ─── Test 25: Empty front throws ─────────────────────────────────────

Deno.test("validate-llm-output: empty flashcard front throws", () => {
  const input = {
    front: "",
    back: "Answer",
  };

  assertThrows(
    () => validateFlashcard(input),
    Error,
    "empty flashcard front",
  );
});

// ─── Test 26: Empty back throws ──────────────────────────────────────

Deno.test("validate-llm-output: empty flashcard back throws", () => {
  const input = {
    front: "Question",
    back: "",
  };

  assertThrows(
    () => validateFlashcard(input),
    Error,
    "empty flashcard back",
  );
});

// ─── Test 27: Whitespace-only front throws ──────────────────────────

Deno.test("validate-llm-output: whitespace-only flashcard front throws", () => {
  const input = {
    front: "   \n\t  ",
    back: "Answer",
  };

  assertThrows(
    () => validateFlashcard(input),
    Error,
    "empty flashcard front",
  );
});

// ─── Test 28: Whitespace-only back throws ───────────────────────────

Deno.test("validate-llm-output: whitespace-only flashcard back throws", () => {
  const input = {
    front: "Question",
    back: "   \n\t  ",
  };

  assertThrows(
    () => validateFlashcard(input),
    Error,
    "empty flashcard back",
  );
});

// ─── Test 29: Front with only HTML tags throws ──────────────────────

Deno.test("validate-llm-output: flashcard front with only HTML tags throws", () => {
  const input = {
    front: "<div><span></span></div>",
    back: "Answer",
  };

  assertThrows(
    () => validateFlashcard(input),
    Error,
    "empty flashcard front",
  );
});

// ─── Test 30: Back with only HTML tags throws ──────────────────────

Deno.test("validate-llm-output: flashcard back with only HTML tags throws", () => {
  const input = {
    front: "Question",
    back: "<p></p><div></div>",
  };

  assertThrows(
    () => validateFlashcard(input),
    Error,
    "empty flashcard back",
  );
});

// ─── Test 31: Flashcard with whitespace preserved around content ────

Deno.test("validate-llm-output: flashcard whitespace trimmed but content preserved", () => {
  const input = {
    front: "  \n  Question text  \n  ",
    back: "  \n  Answer text  \n  ",
  };

  const result = validateFlashcard(input);

  assertEquals(result.front, "Question text");
  assertEquals(result.back, "Answer text");
});

// ─── Test 32: Unicode in flashcard preserved ─────────────────────────

Deno.test("validate-llm-output: flashcard with unicode characters preserved", () => {
  const input = {
    front: "細胞膜(さいぼうまく)とは？",
    back: "細胞を保護し、物質の出入りをコントロールする膜。",
  };

  const result = validateFlashcard(input);

  assertEquals(result.front, "細胞膜(さいぼうまく)とは？");
  assertEquals(result.back, "細胞を保護し、物質の出入りをコントロールする膜。");
});

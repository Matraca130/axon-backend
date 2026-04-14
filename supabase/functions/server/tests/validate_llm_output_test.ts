/**
 * Tests for validate-llm-output.ts — AXO-126
 *
 * Covers:
 *   - P0: MCQ correct_answer validated against options
 *   - P1: question_type structure validation
 *   - Existing sanitization behavior (regression)
 */

import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import {
  validateQuizQuestion,
  validateCorrectAnswerInOptions,
  validateFlashcard,
} from "../lib/validate-llm-output.ts";

// ═══════════════════════════════════════════════════════════
// validateCorrectAnswerInOptions (P0)
// ═══════════════════════════════════════════════════════════

Deno.test("P0: exact match passes", () => {
  const result = validateCorrectAnswerInOptions("Paris", ["London", "Paris", "Berlin"]);
  assertEquals(result, "Paris");
});

Deno.test("P0: letter index 'A' matches first option", () => {
  const result = validateCorrectAnswerInOptions("A", ["A) Paris", "B) London", "C) Berlin"]);
  assertEquals(result, "A");
});

Deno.test("P0: letter index 'C' matches third option", () => {
  const result = validateCorrectAnswerInOptions("C", ["Paris", "London", "Berlin"]);
  assertEquals(result, "C");
});

Deno.test("P0: lowercase letter index 'b' matches", () => {
  const result = validateCorrectAnswerInOptions("b", ["Paris", "London"]);
  assertEquals(result, "b");
});

Deno.test("P0: prefix match with ')' separator", () => {
  const result = validateCorrectAnswerInOptions("B", ["A) Cat", "B) Dog", "C) Fish"]);
  assertEquals(result, "B");
});

Deno.test("P0: prefix match with '.' separator", () => {
  const result = validateCorrectAnswerInOptions("A", ["A. Cat", "B. Dog"]);
  assertEquals(result, "A");
});

Deno.test("P0: case-insensitive match", () => {
  const result = validateCorrectAnswerInOptions("paris", ["London", "Paris", "Berlin"]);
  assertEquals(result, "Paris");
});

Deno.test("P0: throws when answer doesn't match any option", () => {
  assertThrows(
    () => validateCorrectAnswerInOptions("Tokyo", ["London", "Paris", "Berlin"]),
    Error,
    "does not match any option",
  );
});

Deno.test("P0: letter index out of range throws", () => {
  assertThrows(
    () => validateCorrectAnswerInOptions("E", ["A) Cat", "B) Dog"]),
    Error,
    "does not match any option",
  );
});

// ═══════════════════════════════════════════════════════════
// validateQuizQuestion — MCQ (P0 + P1)
// ═══════════════════════════════════════════════════════════

Deno.test("MCQ: valid question with letter answer passes", () => {
  const result = validateQuizQuestion(
    {
      question: "What is 2 + 2?",
      options: ["A) 3", "B) 4", "C) 5", "D) 6"],
      correct_answer: "B",
      explanation: "Basic math",
    },
    "mcq",
  );
  assertEquals(result.question_type, "mcq");
  assertEquals(result.correct_answer, "B");
  assertEquals(result.options?.length, 4);
});

Deno.test("MCQ: throws when options missing", () => {
  assertThrows(
    () =>
      validateQuizQuestion(
        { question: "Q?", correct_answer: "A", options: null },
        "mcq",
      ),
    Error,
    "at least 2 options",
  );
});

Deno.test("MCQ: throws when only 1 option", () => {
  assertThrows(
    () =>
      validateQuizQuestion(
        { question: "Q?", correct_answer: "A", options: ["Only one"] },
        "mcq",
      ),
    Error,
    "at least 2 options",
  );
});

Deno.test("MCQ: throws when correct_answer not in options", () => {
  assertThrows(
    () =>
      validateQuizQuestion(
        { question: "Q?", correct_answer: "Tokyo", options: ["London", "Paris"] },
        "mcq",
      ),
    Error,
    "does not match any option",
  );
});

// ═══════════════════════════════════════════════════════════
// validateQuizQuestion — true_false (P1)
// ═══════════════════════════════════════════════════════════

Deno.test("true_false: provides default options when missing", () => {
  const result = validateQuizQuestion(
    { question: "The sky is blue?", correct_answer: "Verdadero", options: null },
    "true_false",
  );
  assertEquals(result.question_type, "true_false");
  assertEquals(result.options, ["Verdadero", "Falso"]);
  assertEquals(result.correct_answer, "Verdadero");
});

Deno.test("true_false: normalizes 'true' to first option", () => {
  const result = validateQuizQuestion(
    { question: "Q?", correct_answer: "true", options: ["Sí", "No"] },
    "true_false",
  );
  assertEquals(result.correct_answer, "Sí");
});

Deno.test("true_false: normalizes 'falso' to second option", () => {
  const result = validateQuizQuestion(
    { question: "Q?", correct_answer: "falso", options: ["Verdadero", "Falso"] },
    "true_false",
  );
  assertEquals(result.correct_answer, "Falso");
});

Deno.test("true_false: throws on invalid answer", () => {
  assertThrows(
    () =>
      validateQuizQuestion(
        { question: "Q?", correct_answer: "maybe", options: ["Verdadero", "Falso"] },
        "true_false",
      ),
    Error,
    "not a valid true/false value",
  );
});

// ═══════════════════════════════════════════════════════════
// validateQuizQuestion — fill_blank / open (P1)
// ═══════════════════════════════════════════════════════════

Deno.test("fill_blank: options set to null", () => {
  const result = validateQuizQuestion(
    { question: "The capital of France is ___", correct_answer: "Paris", options: ["A", "B"] },
    "fill_blank",
  );
  assertEquals(result.question_type, "fill_blank");
  assertEquals(result.options, null);
  assertEquals(result.correct_answer, "Paris");
});

Deno.test("open: options set to null", () => {
  const result = validateQuizQuestion(
    { question: "Explain mitosis", correct_answer: "Cell division process", options: null },
    "open",
  );
  assertEquals(result.question_type, "open");
  assertEquals(result.options, null);
});

// ═══════════════════════════════════════════════════════════
// Regression: sanitization still works
// ═══════════════════════════════════════════════════════════

Deno.test("HTML tags stripped from question", () => {
  const result = validateQuizQuestion(
    {
      question: "<b>Bold</b> question?",
      options: ["A", "B"],
      correct_answer: "A",
    },
    "mcq",
  );
  assertEquals(result.question, "Bold question?");
});

Deno.test("throws on empty question", () => {
  assertThrows(
    () =>
      validateQuizQuestion(
        { question: "", correct_answer: "A", options: ["A", "B"] },
        "mcq",
      ),
    Error,
    "empty question",
  );
});

Deno.test("throws on empty correct_answer", () => {
  assertThrows(
    () =>
      validateQuizQuestion(
        { question: "Q?", correct_answer: "", options: ["A", "B"] },
        "mcq",
      ),
    Error,
    "empty correct_answer",
  );
});

// ═══════════════════════════════════════════════════════════
// validateFlashcard (regression)
// ═══════════════════════════════════════════════════════════

Deno.test("flashcard: valid card passes", () => {
  const result = validateFlashcard({ front: "What is DNA?", back: "Deoxyribonucleic acid" });
  assertEquals(result.front, "What is DNA?");
  assertEquals(result.back, "Deoxyribonucleic acid");
});

Deno.test("flashcard: HTML stripped", () => {
  const result = validateFlashcard({ front: "<script>alert(1)</script>Q", back: "A" });
  assertEquals(result.front, "alert(1)Q");
});

Deno.test("flashcard: throws on empty front", () => {
  assertThrows(
    () => validateFlashcard({ front: "", back: "A" }),
    Error,
    "empty flashcard front",
  );
});

Deno.test("flashcard: throws on empty back", () => {
  assertThrows(
    () => validateFlashcard({ front: "Q", back: "" }),
    Error,
    "empty flashcard back",
  );
});

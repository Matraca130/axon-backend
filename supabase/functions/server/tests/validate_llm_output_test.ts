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
  assertEquals(result, "Paris"); // auto-corrected to proper case
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

Deno.test("MCQ: valid question with exact text answer passes", () => {
  const result = validateQuizQuestion(
    {
      question: "Capital of France?",
      options: ["London", "Paris", "Berlin", "Madrid"],
      correct_answer: "Paris",
      explanation: null,
    },
    "mcq",
  );
  assertEquals(result.correct_answer, "Paris");
});

Deno.test("MCQ: throws if correct_answer doesn't match options", () => {
  assertThrows(
    () =>
      validateQuizQuestion(
        {
          question: "Capital of France?",
          options: ["London", "Berlin", "Madrid", "Rome"],
          correct_answer: "Paris",
          explanation: null,
        },
        "mcq",
      ),
    Error,
    "does not match any option",
  );
});

Deno.test("MCQ: throws if options missing", () => {
  assertThrows(
    () =>
      validateQuizQuestion(
        {
          question: "Capital of France?",
          correct_answer: "Paris",
          explanation: null,
        },
        "mcq",
      ),
    Error,
    "must have at least 2 options",
  );
});

Deno.test("MCQ: throws if only 1 option", () => {
  assertThrows(
    () =>
      validateQuizQuestion(
        {
          question: "Capital of France?",
          options: ["Paris"],
          correct_answer: "Paris",
          explanation: null,
        },
        "mcq",
      ),
    Error,
    "must have at least 2 options",
  );
});

// ═══════════════════════════════════════════════════════════
// validateQuizQuestion — true_false (P1)
// ═══════════════════════════════════════════════════════════

Deno.test("true_false: provides default options when missing", () => {
  const result = validateQuizQuestion(
    {
      question: "The sky is blue",
      correct_answer: "Verdadero",
      explanation: "Obvious",
    },
    "true_false",
  );
  assertEquals(result.question_type, "true_false");
  assertEquals(result.options, ["Verdadero", "Falso"]);
  assertEquals(result.correct_answer, "Verdadero");
});

Deno.test("true_false: normalizes 'true' to first option", () => {
  const result = validateQuizQuestion(
    {
      question: "The sky is blue",
      correct_answer: "true",
      explanation: null,
    },
    "true_false",
  );
  assertEquals(result.correct_answer, "Verdadero"); // mapped to default first option
});

Deno.test("true_false: normalizes 'false' to second option", () => {
  const result = validateQuizQuestion(
    {
      question: "The sky is green",
      correct_answer: "false",
      explanation: null,
    },
    "true_false",
  );
  assertEquals(result.correct_answer, "Falso");
});

Deno.test("true_false: uses provided options", () => {
  const result = validateQuizQuestion(
    {
      question: "Water is wet",
      options: ["Sí", "No"],
      correct_answer: "Sí",
      explanation: null,
    },
    "true_false",
  );
  assertEquals(result.options, ["Sí", "No"]);
  assertEquals(result.correct_answer, "Sí");
});

Deno.test("true_false: trims to 2 options if more provided", () => {
  const result = validateQuizQuestion(
    {
      question: "Water is wet",
      options: ["True", "False", "Maybe"],
      correct_answer: "True",
      explanation: null,
    },
    "true_false",
  );
  assertEquals(result.options?.length, 2);
});

// ═══════════════════════════════════════════════════════════
// validateQuizQuestion — fill_blank / open (P1)
// ═══════════════════════════════════════════════════════════

Deno.test("fill_blank: options set to null", () => {
  const result = validateQuizQuestion(
    {
      question: "The capital of France is ___",
      options: ["Paris", "London"], // LLM might still send options
      correct_answer: "Paris",
      explanation: null,
    },
    "fill_blank",
  );
  assertEquals(result.question_type, "fill_blank");
  assertEquals(result.options, null); // stripped
  assertEquals(result.correct_answer, "Paris");
});

Deno.test("open: options set to null", () => {
  const result = validateQuizQuestion(
    {
      question: "Explain photosynthesis",
      correct_answer: "Plants convert sunlight to energy",
      explanation: "Standard biology concept",
    },
    "open",
  );
  assertEquals(result.question_type, "open");
  assertEquals(result.options, null);
});

// ═══════════════════════════════════════════════════════════
// Sanitization regressions
// ═══════════════════════════════════════════════════════════

Deno.test("strips HTML from question", () => {
  const result = validateQuizQuestion(
    {
      question: "<b>Bold question</b>?",
      options: ["A", "B"],
      correct_answer: "A",
      explanation: null,
    },
    "mcq",
  );
  assertEquals(result.question, "Bold question?");
});

Deno.test("strips HTML from options", () => {
  const result = validateQuizQuestion(
    {
      question: "Test",
      options: ["<i>Option A</i>", "<b>Option B</b>"],
      correct_answer: "Option A",
      explanation: null,
    },
    "mcq",
  );
  assertEquals(result.options, ["Option A", "Option B"]);
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
        { question: "Test", correct_answer: "", options: ["A", "B"] },
        "mcq",
      ),
    Error,
    "empty correct_answer",
  );
});

// ═══════════════════════════════════════════════════════════
// validateFlashcard (regression)
// ═══════════════════════════════════════════════════════════

Deno.test("flashcard: valid input passes", () => {
  const result = validateFlashcard({ front: "Question", back: "Answer" });
  assertEquals(result.front, "Question");
  assertEquals(result.back, "Answer");
});

Deno.test("flashcard: strips HTML", () => {
  const result = validateFlashcard({
    front: "<script>alert(1)</script>What?",
    back: "<b>Answer</b>",
  });
  assertEquals(result.front, "alert(1)What?");
  assertEquals(result.back, "Answer");
});

Deno.test("flashcard: throws on empty front", () => {
  assertThrows(
    () => validateFlashcard({ front: "", back: "Answer" }),
    Error,
    "empty flashcard front",
  );
});

Deno.test("flashcard: throws on empty back", () => {
  assertThrows(
    () => validateFlashcard({ front: "Question", back: "" }),
    Error,
    "empty flashcard back",
  );
});

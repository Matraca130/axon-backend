/**
 * Tests for validate-llm-output.ts — LLM output sanitization + structural validation
 *
 * AXO-119: MCQ correct_answer validation + question_type structural validation
 *
 * Run: deno test supabase/functions/server/tests/validate_llm_output_test.ts
 */

import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  validateQuizQuestion,
  validateFlashcard,
} from "../lib/validate-llm-output.ts";

// ═════════════════════════════════════════════════════════
// 1. Basic validateQuizQuestion (no question_type)
// ═════════════════════════════════════════════════════════

Deno.test("validateQuizQuestion: valid MCQ passes", () => {
  const result = validateQuizQuestion({
    question: "¿Qué es TCP?",
    options: ["Protocolo", "Red", "Hardware", "Software"],
    correct_answer: "A",
    explanation: "TCP es un protocolo de transporte.",
  });
  assertEquals(result.question, "¿Qué es TCP?");
  assertEquals(result.options?.length, 4);
  assertEquals(result.correct_answer, "A");
});

Deno.test("validateQuizQuestion: throws on empty question", () => {
  assertThrows(
    () => validateQuizQuestion({ question: "", correct_answer: "A" }),
    Error,
    "empty question",
  );
});

Deno.test("validateQuizQuestion: throws on empty correct_answer", () => {
  assertThrows(
    () => validateQuizQuestion({ question: "Q?", correct_answer: "" }),
    Error,
    "empty correct_answer",
  );
});

Deno.test("validateQuizQuestion: strips HTML from question", () => {
  const result = validateQuizQuestion({
    question: "<b>Bold</b> question?",
    correct_answer: "A",
    options: ["Yes", "No"],
  });
  assertEquals(result.question, "Bold question?");
});

// ═════════════════════════════════════════════════════════
// 2. Bug 1: MCQ correct_answer vs options (AXO-119)
// ═════════════════════════════════════════════════════════

Deno.test("AXO-119 Bug1: MCQ correct_answer 'E' with 4 options → corrected to 'A'", () => {
  const result = validateQuizQuestion(
    {
      question: "¿Cuál es correcto?",
      options: ["Op A", "Op B", "Op C", "Op D"],
      correct_answer: "E",
      explanation: null,
    },
    "mcq",
  );
  assertEquals(result.correct_answer, "A");
});

Deno.test("AXO-119 Bug1: MCQ correct_answer 'B' with 4 options → kept", () => {
  const result = validateQuizQuestion(
    {
      question: "¿Cuál es correcto?",
      options: ["Op A", "Op B", "Op C", "Op D"],
      correct_answer: "B",
      explanation: null,
    },
    "mcq",
  );
  assertEquals(result.correct_answer, "B");
});

Deno.test("AXO-119 Bug1: MCQ correct_answer 'Z' with 2 options → corrected to 'A'", () => {
  const result = validateQuizQuestion(
    {
      question: "¿Cuál?",
      options: ["Sí", "No"],
      correct_answer: "Z",
    },
    "mcq",
  );
  assertEquals(result.correct_answer, "A");
});

Deno.test("AXO-119 Bug1: fallback validation without questionType — 'E' corrected", () => {
  const result = validateQuizQuestion({
    question: "¿Cuál?",
    options: ["A1", "A2", "A3"],
    correct_answer: "E",
  });
  assertEquals(result.correct_answer, "A");
});

Deno.test("AXO-119 Bug1: MCQ throws when fewer than 2 options", () => {
  assertThrows(
    () =>
      validateQuizQuestion(
        { question: "Q?", options: ["Solo una"], correct_answer: "A" },
        "mcq",
      ),
    Error,
    "at least 2 options",
  );
});

Deno.test("AXO-119 Bug1: MCQ throws when no options", () => {
  assertThrows(
    () =>
      validateQuizQuestion(
        { question: "Q?", options: [], correct_answer: "A" },
        "mcq",
      ),
    Error,
    "at least 2 options",
  );
});

// ═════════════════════════════════════════════════════════
// 3. Bug 2: question_type structural validation (AXO-119)
// ═════════════════════════════════════════════════════════

Deno.test("AXO-119 Bug2: true_false with 4 MCQ options → forced to ['Verdadero', 'Falso']", () => {
  const result = validateQuizQuestion(
    {
      question: "¿Es verdad?",
      options: ["Op A", "Op B", "Op C", "Op D"],
      correct_answer: "A",
    },
    "true_false",
  );
  assertEquals(result.options, ["Verdadero", "Falso"]);
});

Deno.test("AXO-119 Bug2: true_false answer 'Falso' → mapped to 'B'", () => {
  const result = validateQuizQuestion(
    {
      question: "¿Es verdad?",
      options: ["V", "F"],
      correct_answer: "Falso",
    },
    "true_false",
  );
  assertEquals(result.correct_answer, "B");
  assertEquals(result.options, ["Verdadero", "Falso"]);
});

Deno.test("AXO-119 Bug2: true_false answer 'False' → mapped to 'B'", () => {
  const result = validateQuizQuestion(
    {
      question: "Is it true?",
      options: [],
      correct_answer: "False",
    },
    "true_false",
  );
  assertEquals(result.correct_answer, "B");
});

Deno.test("AXO-119 Bug2: true_false answer 'A' → kept as 'A'", () => {
  const result = validateQuizQuestion(
    {
      question: "¿Es verdad?",
      options: [],
      correct_answer: "A",
    },
    "true_false",
  );
  assertEquals(result.correct_answer, "A");
});

Deno.test("AXO-119 Bug2: true_false invalid answer 'C' → defaults to 'A'", () => {
  const result = validateQuizQuestion(
    {
      question: "¿Es verdad?",
      options: [],
      correct_answer: "C",
    },
    "true_false",
  );
  assertEquals(result.correct_answer, "A");
});

Deno.test("AXO-119 Bug2: fill_blank with options → options cleared", () => {
  const result = validateQuizQuestion(
    {
      question: "La capital de Argentina es ___",
      options: ["Buenos Aires", "Lima", "Santiago"],
      correct_answer: "Buenos Aires",
    },
    "fill_blank",
  );
  assertEquals(result.options, null);
  assertEquals(result.correct_answer, "Buenos Aires");
});

Deno.test("AXO-119 Bug2: open with options → options cleared", () => {
  const result = validateQuizQuestion(
    {
      question: "Explique el ciclo de Krebs",
      options: ["Op A", "Op B"],
      correct_answer: "El ciclo de Krebs es...",
    },
    "open",
  );
  assertEquals(result.options, null);
  assertEquals(result.correct_answer, "El ciclo de Krebs es...");
});

// ═════════════════════════════════════════════════════════
// 4. validateFlashcard (unchanged, regression tests)
// ═════════════════════════════════════════════════════════

Deno.test("validateFlashcard: valid card passes", () => {
  const result = validateFlashcard({ front: "¿Qué es DNS?", back: "Domain Name System" });
  assertEquals(result.front, "¿Qué es DNS?");
  assertEquals(result.back, "Domain Name System");
});

Deno.test("validateFlashcard: throws on empty front", () => {
  assertThrows(
    () => validateFlashcard({ front: "", back: "Answer" }),
    Error,
    "empty flashcard front",
  );
});

Deno.test("validateFlashcard: throws on empty back", () => {
  assertThrows(
    () => validateFlashcard({ front: "Question?", back: "" }),
    Error,
    "empty flashcard back",
  );
});

Deno.test("validateFlashcard: strips HTML", () => {
  const result = validateFlashcard({
    front: "<script>alert(1)</script>Question?",
    back: "<b>Answer</b>",
  });
  assertEquals(result.front, "alert(1)Question?");
  assertEquals(result.back, "Answer");
});

/**
 * Tests for AXO-124: AI quiz validation fixes
 *
 * P0: MCQ correct_answer validated against options array
 * P1: question_type reconciled against actual structure
 *
 * Run: deno test supabase/functions/server/tests/ai_quiz_validation_test.ts
 */

import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { validateQuizQuestion, validateFlashcard } from "../lib/validate-llm-output.ts";
import {
  normalizeQuestionType,
  normalizeDifficulty,
  inferQuestionTypeFromStructure,
  reconcileQuestionType,
  sanitizeQuizFields,
} from "../ai-normalizers.ts";

// ══════════════════════════════════════════════════════════════
// P0: correct_answer validation against options
// ══════════════════════════════════════════════════════════════

Deno.test("P0: correct_answer exact match in options — no change", () => {
  const result = validateQuizQuestion({
    question: "What is 2+2?",
    options: ["A) 3", "B) 4", "C) 5", "D) 6"],
    correct_answer: "B) 4",
    explanation: "Basic math",
  });
  assertEquals(result.correct_answer, "B) 4");
});

Deno.test("P0: correct_answer case-insensitive match", () => {
  const result = validateQuizQuestion({
    question: "Is the sky blue?",
    options: ["True", "False"],
    correct_answer: "true",
    explanation: null,
  });
  assertEquals(result.correct_answer, "True");
});

Deno.test("P0: correct_answer prefix match (LLM returns 'A' instead of 'A) ...')", () => {
  const result = validateQuizQuestion({
    question: "Capital of France?",
    options: ["A) Paris", "B) London", "C) Berlin", "D) Madrid"],
    correct_answer: "A",
    explanation: null,
  });
  // "A" is a prefix of "A) Paris" — should match
  assertEquals(result.correct_answer, "A) Paris");
});

Deno.test("P0: correct_answer falls back to first option when no match", () => {
  const result = validateQuizQuestion({
    question: "What color is grass?",
    options: ["Red", "Green", "Blue", "Yellow"],
    correct_answer: "Totally wrong answer",
    explanation: null,
  });
  assertEquals(result.correct_answer, "Red");
});

Deno.test("P0: correct_answer without options — no validation needed", () => {
  const result = validateQuizQuestion({
    question: "Explain photosynthesis",
    options: null,
    correct_answer: "Plants convert sunlight to energy",
    explanation: null,
  });
  assertEquals(result.correct_answer, "Plants convert sunlight to energy");
  assertEquals(result.options, null);
});

Deno.test("P0: correct_answer with empty options array — no validation", () => {
  const result = validateQuizQuestion({
    question: "Explain gravity",
    options: [],
    correct_answer: "Gravitational force",
    explanation: null,
  });
  assertEquals(result.correct_answer, "Gravitational force");
  assertEquals(result.options, null);
});

Deno.test("P0: still throws on empty question", () => {
  assertThrows(
    () => validateQuizQuestion({
      question: "",
      options: ["A", "B"],
      correct_answer: "A",
      explanation: null,
    }),
    Error,
    "empty question",
  );
});

Deno.test("P0: still throws on empty correct_answer", () => {
  assertThrows(
    () => validateQuizQuestion({
      question: "What?",
      options: ["A", "B"],
      correct_answer: "",
      explanation: null,
    }),
    Error,
    "empty correct_answer",
  );
});

// ══════════════════════════════════════════════════════════════
// P1: question_type vs structure reconciliation
// ══════════════════════════════════════════════════════════════

// ── inferQuestionTypeFromStructure ──────────────────────────

Deno.test("P1 infer: 4 options → mcq", () => {
  const result = inferQuestionTypeFromStructure({
    options: ["A) Paris", "B) London", "C) Berlin", "D) Madrid"],
  });
  assertEquals(result, "mcq");
});

Deno.test("P1 infer: 2 true/false options → true_false", () => {
  const result = inferQuestionTypeFromStructure({
    options: ["Verdadero", "Falso"],
  });
  assertEquals(result, "true_false");
});

Deno.test("P1 infer: 2 True/False options (English) → true_false", () => {
  const result = inferQuestionTypeFromStructure({
    options: ["True", "False"],
  });
  assertEquals(result, "true_false");
});

Deno.test("P1 infer: 2 non-boolean options → mcq", () => {
  const result = inferQuestionTypeFromStructure({
    options: ["Paris", "London"],
  });
  assertEquals(result, "mcq");
});

Deno.test("P1 infer: no options → null (can't infer)", () => {
  const result = inferQuestionTypeFromStructure({});
  assertEquals(result, null);
});

Deno.test("P1 infer: empty options array → null", () => {
  const result = inferQuestionTypeFromStructure({ options: [] });
  assertEquals(result, null);
});

// ── reconcileQuestionType ───────────────────────────────────

Deno.test("P1 reconcile: declared mcq + 4 options → mcq (consistent)", () => {
  const result = reconcileQuestionType("mcq", {
    options: ["A", "B", "C", "D"],
  });
  assertEquals(result, "mcq");
});

Deno.test("P1 reconcile: declared mcq + true/false options → true_false (corrected)", () => {
  const result = reconcileQuestionType("mcq", {
    options: ["Verdadero", "Falso"],
  });
  assertEquals(result, "true_false");
});

Deno.test("P1 reconcile: declared true_false + 4 options → mcq (corrected)", () => {
  const result = reconcileQuestionType("true_false", {
    options: ["A) Paris", "B) London", "C) Berlin", "D) Madrid"],
  });
  assertEquals(result, "mcq");
});

Deno.test("P1 reconcile: declared mcq + no options → open (corrected)", () => {
  const result = reconcileQuestionType("mcq", {});
  assertEquals(result, "open");
});

Deno.test("P1 reconcile: declared true_false + no options → open (corrected)", () => {
  const result = reconcileQuestionType("true_false", { options: [] });
  assertEquals(result, "open");
});

Deno.test("P1 reconcile: declared open + no options → open (consistent)", () => {
  const result = reconcileQuestionType("open", {});
  assertEquals(result, "open");
});

Deno.test("P1 reconcile: declared fill_blank + no options → fill_blank (consistent)", () => {
  const result = reconcileQuestionType("fill_blank", {});
  assertEquals(result, "fill_blank");
});

// ── sanitizeQuizFields (integration) ────────────────────────

Deno.test("P1 sanitizeQuizFields: corrects type mismatch end-to-end", () => {
  const result = sanitizeQuizFields({
    question_type: "mcq",
    difficulty: "hard",
    options: ["Verdadero", "Falso"],
  });
  assertEquals(result.question_type, "true_false");
  assertEquals(result.difficulty, 3);
});

Deno.test("P1 sanitizeQuizFields: consistent MCQ passes through", () => {
  const result = sanitizeQuizFields({
    question_type: "multiple_choice",
    difficulty: 2,
    options: ["A", "B", "C", "D"],
  });
  assertEquals(result.question_type, "mcq");
  assertEquals(result.difficulty, 2);
});

// ── Existing normalizer behavior preserved ──────────────────

Deno.test("normalizeQuestionType: existing behavior unchanged", () => {
  assertEquals(normalizeQuestionType("mcq"), "mcq");
  assertEquals(normalizeQuestionType("multiple_choice"), "mcq");
  assertEquals(normalizeQuestionType("true_false"), "true_false");
  assertEquals(normalizeQuestionType("verdadero_falso"), "true_false");
  assertEquals(normalizeQuestionType("fill_blank"), "fill_blank");
  assertEquals(normalizeQuestionType("open"), "open");
  assertEquals(normalizeQuestionType("unknown_junk"), "mcq");
  assertEquals(normalizeQuestionType(123), "mcq");
});

Deno.test("normalizeDifficulty: existing behavior unchanged", () => {
  assertEquals(normalizeDifficulty(1), 1);
  assertEquals(normalizeDifficulty(2), 2);
  assertEquals(normalizeDifficulty(3), 3);
  assertEquals(normalizeDifficulty("easy"), 1);
  assertEquals(normalizeDifficulty("medium"), 2);
  assertEquals(normalizeDifficulty("hard"), 3);
  assertEquals(normalizeDifficulty("dificil"), 3);
  assertEquals(normalizeDifficulty("unknown"), 2);
});

// ── validateFlashcard still works ───────────────────────────

Deno.test("validateFlashcard: basic validation unchanged", () => {
  const result = validateFlashcard({
    front: "What is DNA?",
    back: "Deoxyribonucleic acid",
  });
  assertEquals(result.front, "What is DNA?");
  assertEquals(result.back, "Deoxyribonucleic acid");
});

Deno.test("validateFlashcard: throws on empty front", () => {
  assertThrows(
    () => validateFlashcard({ front: "", back: "answer" }),
    Error,
    "empty flashcard front",
  );
});

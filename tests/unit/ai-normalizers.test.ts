/**
 * tests/unit/ai-normalizers.test.ts — Unit tests for AI output normalization
 *
 * 28 tests covering:
 * - normalizeDifficulty: number pass-through, string mapping (EN/ES), boundary values, defaults
 * - normalizeQuestionType: MCQ/TF/Fill/Open variants, case-insensitive, underscores/hyphens, defaults
 * - sanitizeQuizFields: combined normalization, object handling
 *
 * Run:
 *   cd /sessions/great-bold-mccarthy/mnt/petri/AXON\ PROJECTO/backend
 *   deno test tests/unit/ai-normalizers.test.ts --allow-env --no-check
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import {
  normalizeDifficulty,
  normalizeQuestionType,
  sanitizeQuizFields,
  type DbDifficulty,
  type DbQuestionType,
} from "../../supabase/functions/server/ai-normalizers.ts";

// ─── normalizeDifficulty Tests ──────────────────────────────────────

Deno.test("normalizeDifficulty: pass-through valid number 1", () => {
  const result = normalizeDifficulty(1);
  assertEquals(result, 1);
});

Deno.test("normalizeDifficulty: pass-through valid number 2", () => {
  const result = normalizeDifficulty(2);
  assertEquals(result, 2);
});

Deno.test("normalizeDifficulty: pass-through valid number 3", () => {
  const result = normalizeDifficulty(3);
  assertEquals(result, 3);
});

Deno.test("normalizeDifficulty: clamp 0 to 1", () => {
  const result = normalizeDifficulty(0);
  assertEquals(result, 1);
});

Deno.test("normalizeDifficulty: clamp negative to 1", () => {
  const result = normalizeDifficulty(-5);
  assertEquals(result, 1);
});

Deno.test("normalizeDifficulty: clamp 4+ to 3", () => {
  const result = normalizeDifficulty(4);
  assertEquals(result, 3);
});

Deno.test("normalizeDifficulty: clamp 100 to 3", () => {
  const result = normalizeDifficulty(100);
  assertEquals(result, 3);
});

Deno.test("normalizeDifficulty: round fractional 1.5 to 2", () => {
  const result = normalizeDifficulty(1.5);
  assertEquals(result, 2);
});

Deno.test("normalizeDifficulty: round fractional 2.4 to 2", () => {
  const result = normalizeDifficulty(2.4);
  assertEquals(result, 2);
});

Deno.test("normalizeDifficulty: round fractional 2.6 to 3", () => {
  const result = normalizeDifficulty(2.6);
  assertEquals(result, 3);
});

Deno.test("normalizeDifficulty: string 'easy' → 1", () => {
  const result = normalizeDifficulty("easy");
  assertEquals(result, 1);
});

Deno.test("normalizeDifficulty: string 'medium' → 2", () => {
  const result = normalizeDifficulty("medium");
  assertEquals(result, 2);
});

Deno.test("normalizeDifficulty: string 'hard' → 3", () => {
  const result = normalizeDifficulty("hard");
  assertEquals(result, 3);
});

Deno.test("normalizeDifficulty: Spanish 'facil' → 1", () => {
  const result = normalizeDifficulty("facil");
  assertEquals(result, 1);
});

Deno.test("normalizeDifficulty: Spanish 'media' → 2", () => {
  const result = normalizeDifficulty("media");
  assertEquals(result, 2);
});

Deno.test("normalizeDifficulty: Spanish 'medio' → 2", () => {
  const result = normalizeDifficulty("medio");
  assertEquals(result, 2);
});

Deno.test("normalizeDifficulty: Spanish 'dificil' → 3", () => {
  const result = normalizeDifficulty("dificil");
  assertEquals(result, 3);
});

Deno.test("normalizeDifficulty: case-insensitive 'EASY' → 1", () => {
  const result = normalizeDifficulty("EASY");
  assertEquals(result, 1);
});

Deno.test("normalizeDifficulty: case-insensitive 'Medium' → 2", () => {
  const result = normalizeDifficulty("Medium");
  assertEquals(result, 2);
});

Deno.test("normalizeDifficulty: trim whitespace ' easy ' → 1", () => {
  const result = normalizeDifficulty("  easy  ");
  assertEquals(result, 1);
});

Deno.test("normalizeDifficulty: unknown string defaults to 2", () => {
  const result = normalizeDifficulty("impossible");
  assertEquals(result, 2);
});

Deno.test("normalizeDifficulty: empty string defaults to 2", () => {
  const result = normalizeDifficulty("");
  assertEquals(result, 2);
});

Deno.test("normalizeDifficulty: null defaults to 2", () => {
  const result = normalizeDifficulty(null);
  assertEquals(result, 2);
});

Deno.test("normalizeDifficulty: undefined defaults to 2", () => {
  const result = normalizeDifficulty(undefined);
  assertEquals(result, 2);
});

Deno.test("normalizeDifficulty: object defaults to 2", () => {
  const result = normalizeDifficulty({ level: 1 });
  assertEquals(result, 2);
});

Deno.test("normalizeDifficulty: boolean defaults to 2", () => {
  const result = normalizeDifficulty(true);
  assertEquals(result, 2);
});

// ─── normalizeQuestionType Tests ────────────────────────────────────

Deno.test("normalizeQuestionType: 'mcq' → 'mcq'", () => {
  const result = normalizeQuestionType("mcq");
  assertEquals(result, "mcq");
});

Deno.test("normalizeQuestionType: 'multiple_choice' → 'mcq'", () => {
  const result = normalizeQuestionType("multiple_choice");
  assertEquals(result, "mcq");
});

Deno.test("normalizeQuestionType: 'multiplechoice' → 'mcq'", () => {
  const result = normalizeQuestionType("multiplechoice");
  assertEquals(result, "mcq");
});

Deno.test("normalizeQuestionType: 'opcion_multiple' → 'mcq'", () => {
  const result = normalizeQuestionType("opcion_multiple");
  assertEquals(result, "mcq");
});

Deno.test("normalizeQuestionType: 'true_false' → 'true_false'", () => {
  const result = normalizeQuestionType("true_false");
  assertEquals(result, "true_false");
});

Deno.test("normalizeQuestionType: 'truefalse' → 'true_false'", () => {
  const result = normalizeQuestionType("truefalse");
  assertEquals(result, "true_false");
});

Deno.test("normalizeQuestionType: 'verdadero_falso' → 'true_false'", () => {
  const result = normalizeQuestionType("verdadero_falso");
  assertEquals(result, "true_false");
});

Deno.test("normalizeQuestionType: 'fill_blank' → 'fill_blank'", () => {
  const result = normalizeQuestionType("fill_blank");
  assertEquals(result, "fill_blank");
});

Deno.test("normalizeQuestionType: 'fillblank' → 'fill_blank'", () => {
  const result = normalizeQuestionType("fillblank");
  assertEquals(result, "fill_blank");
});

Deno.test("normalizeQuestionType: 'fill_in_the_blank' → 'fill_blank'", () => {
  const result = normalizeQuestionType("fill_in_the_blank");
  assertEquals(result, "fill_blank");
});

Deno.test("normalizeQuestionType: 'completar' → 'fill_blank'", () => {
  const result = normalizeQuestionType("completar");
  assertEquals(result, "fill_blank");
});

Deno.test("normalizeQuestionType: 'open' → 'open'", () => {
  const result = normalizeQuestionType("open");
  assertEquals(result, "open");
});

Deno.test("normalizeQuestionType: 'open_ended' → 'open'", () => {
  const result = normalizeQuestionType("open_ended");
  assertEquals(result, "open");
});

Deno.test("normalizeQuestionType: 'abierta' → 'open'", () => {
  const result = normalizeQuestionType("abierta");
  assertEquals(result, "open");
});

Deno.test("normalizeQuestionType: 'respuesta_abierta' → 'open'", () => {
  const result = normalizeQuestionType("respuesta_abierta");
  assertEquals(result, "open");
});

Deno.test("normalizeQuestionType: case-insensitive 'MCQ' → 'mcq'", () => {
  const result = normalizeQuestionType("MCQ");
  assertEquals(result, "mcq");
});

Deno.test("normalizeQuestionType: case-insensitive 'TRUE_FALSE' → 'true_false'", () => {
  const result = normalizeQuestionType("TRUE_FALSE");
  assertEquals(result, "true_false");
});

Deno.test("normalizeQuestionType: handles hyphens 'multiple-choice' → 'mcq'", () => {
  const result = normalizeQuestionType("multiple-choice");
  assertEquals(result, "mcq");
});

Deno.test("normalizeQuestionType: handles spaces 'multiple choice' → 'mcq'", () => {
  const result = normalizeQuestionType("multiple choice");
  assertEquals(result, "mcq");
});

Deno.test("normalizeQuestionType: trims whitespace ' mcq ' → 'mcq'", () => {
  const result = normalizeQuestionType("  mcq  ");
  assertEquals(result, "mcq");
});

Deno.test("normalizeQuestionType: unknown string defaults to 'mcq'", () => {
  const result = normalizeQuestionType("essay");
  assertEquals(result, "mcq");
});

Deno.test("normalizeQuestionType: non-string defaults to 'mcq'", () => {
  const result = normalizeQuestionType(42);
  assertEquals(result, "mcq");
});

Deno.test("normalizeQuestionType: null defaults to 'mcq'", () => {
  const result = normalizeQuestionType(null);
  assertEquals(result, "mcq");
});

Deno.test("normalizeQuestionType: undefined defaults to 'mcq'", () => {
  const result = normalizeQuestionType(undefined);
  assertEquals(result, "mcq");
});

Deno.test("normalizeQuestionType: empty string defaults to 'mcq'", () => {
  const result = normalizeQuestionType("");
  assertEquals(result, "mcq");
});

// ─── sanitizeQuizFields Tests ────────────────────────────────────────

Deno.test("sanitizeQuizFields: normalizes both difficulty and question_type", () => {
  const input = {
    question_type: "multiple_choice",
    difficulty: "easy",
    other_field: "ignored",
  };
  const result = sanitizeQuizFields(input);
  assertEquals(result.question_type, "mcq");
  assertEquals(result.difficulty, 1);
});

Deno.test("sanitizeQuizFields: handles missing fields with defaults", () => {
  const input = {};
  const result = sanitizeQuizFields(input);
  assertEquals(result.question_type, "mcq");
  assertEquals(result.difficulty, 2);
});

Deno.test("sanitizeQuizFields: sanitizes invalid values", () => {
  const input = {
    question_type: "invalid_type",
    difficulty: "impossible",
  };
  const result = sanitizeQuizFields(input);
  assertEquals(result.question_type, "mcq");
  assertEquals(result.difficulty, 2);
});

Deno.test("sanitizeQuizFields: preserves valid numeric difficulty", () => {
  const input = {
    question_type: "true_false",
    difficulty: 3,
  };
  const result = sanitizeQuizFields(input);
  assertEquals(result.question_type, "true_false");
  assertEquals(result.difficulty, 3);
});

Deno.test("sanitizeQuizFields: handles complex object with extra fields", () => {
  const input = {
    id: "q123",
    question_type: "fill_in_the_blank",
    difficulty: 2.7,
    content: "What is the capital?",
    options: ["A", "B", "C"],
  };
  const result = sanitizeQuizFields(input);
  assertEquals(result.question_type, "fill_blank");
  assertEquals(result.difficulty, 3);
});

Deno.test("sanitizeQuizFields: returns SanitizedQuizFields type", () => {
  const input = {
    question_type: "open",
    difficulty: 2,
  };
  const result = sanitizeQuizFields(input);
  assert(typeof result === "object");
  assert("question_type" in result);
  assert("difficulty" in result);
  assertEquals(Object.keys(result).length, 2);
});

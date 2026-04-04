/**
 * validate-llm-output.ts — Sanitize + validate AI-generated content before DB INSERT
 *
 * AI-001 FIX: Security audit 2026-03-18
 * AXO-126 FIX: MCQ correct_answer validated against options + question_type structure validation
 *
 * Strategy: Strip HTML tags from text fields. Quiz questions and flashcards
 * are plain text — they should NEVER contain HTML. The frontend renders
 * them via React textContent (not innerHTML), so HTML entities would
 * display literally. Stripping tags is the correct approach.
 */

import type { DbQuestionType } from "../ai-normalizers.ts";

// ── HTML Tag Stripping ─────────────────────────────────

/**
 * Remove HTML tags from a string, preserving text content.
 * "<script>alert(1)</script>" → "alert(1)" (harmless as plain text)
 * "<b>bold</b> text" → "bold text"
 * "Is 5 > 3?" → "Is 5 > 3?" (preserved, not inside a tag)
 */
function stripHtmlTags(str: string): string {
  return str.replace(/<[^>]*>/g, '');
}

// ── Field Validators ─────────────────────────────────────

const MAX_QUESTION_LENGTH = 2000;
const MAX_EXPLANATION_LENGTH = 5000;
const MAX_OPTION_LENGTH = 500;
const MAX_OPTIONS_COUNT = 6;
const MAX_FLASHCARD_SIDE_LENGTH = 3000;

/**
 * Sanitize a text field from LLM output.
 * - Strips HTML tags
 * - Trims whitespace
 * - Enforces max length
 * - Returns null if empty after trim
 */
function sanitizeTextField(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  const str = typeof value === 'string' ? value : String(value);
  const stripped = stripHtmlTags(str).trim();
  if (!stripped) return null;
  return stripped.slice(0, maxLength);
}

/**
 * Sanitize an options array from LLM output (MCQ answers).
 */
function sanitizeOptions(options: unknown): string[] | null {
  if (!Array.isArray(options)) return null;
  const sanitized = options
    .slice(0, MAX_OPTIONS_COUNT)
    .map((opt) => sanitizeTextField(opt, MAX_OPTION_LENGTH))
    .filter((opt): opt is string => opt !== null);
  return sanitized.length > 0 ? sanitized : null;
}

// ── MCQ correct_answer validation (AXO-126 P0) ──────────

/**
 * Validate that correct_answer refers to a valid option in the MCQ.
 *
 * Accepts:
 *   1. Exact match:          correct_answer === options[i]
 *   2. Letter index:         "A"/"B"/"C"/"D" maps to options[0]/[1]/[2]/[3]
 *   3. Prefix match:         option starts with "A)" or "A."
 *   4. Case-insensitive:     case-insensitive exact match
 *
 * Returns the validated correct_answer (unchanged if valid).
 * Throws if no match found.
 */
export function validateCorrectAnswerInOptions(
  correctAnswer: string,
  options: string[],
): string {
  // 1. Exact match
  if (options.includes(correctAnswer)) return correctAnswer;

  const upper = correctAnswer.trim().toUpperCase();

  // 2. Letter index match: "A" → 0, "B" → 1, etc.
  if (upper.length === 1 && upper >= "A" && upper <= "Z") {
    const idx = upper.charCodeAt(0) - 65; // A=0, B=1, ...
    if (idx >= 0 && idx < options.length) return correctAnswer;
  }

  // 3. Prefix match: an option starts with "A)" or "A."
  if (upper.length === 1) {
    const prefixMatch = options.find((opt) => {
      const trimmed = opt.trim().toUpperCase();
      return trimmed.startsWith(upper + ")") || trimmed.startsWith(upper + ".");
    });
    if (prefixMatch) return correctAnswer;
  }

  // 4. Case-insensitive exact match
  const lower = correctAnswer.toLowerCase();
  const caseMatch = options.find((opt) => opt.toLowerCase() === lower);
  if (caseMatch) return caseMatch;

  throw new Error(
    `MCQ correct_answer "${correctAnswer}" does not match any option. Options: ${JSON.stringify(options)}`,
  );
}

// ── True/False answer normalization (AXO-126 P1) ────────

const TRUE_FALSE_TRUE = new Set([
  "true", "verdadero", "verdadera", "v", "si", "sí", "correcto",
]);
const TRUE_FALSE_FALSE = new Set([
  "false", "falso", "falsa", "f", "no", "incorrecto",
]);

function validateTrueFalseAnswer(correctAnswer: string, options: string[]): string {
  const lower = correctAnswer.toLowerCase().trim();

  // If it matches an option directly, use it
  if (options.includes(correctAnswer)) return correctAnswer;

  // Case-insensitive match against options
  const caseMatch = options.find((opt) => opt.toLowerCase() === lower);
  if (caseMatch) return caseMatch;

  // Normalize to "Verdadero"/"Falso" defaults
  if (TRUE_FALSE_TRUE.has(lower)) return options[0]; // first option = true
  if (TRUE_FALSE_FALSE.has(lower)) return options[1]; // second option = false

  throw new Error(
    `True/false correct_answer "${correctAnswer}" is not a valid true/false value`,
  );
}

// ── High-Level Validators ────────────────────────────────

export interface ValidatedQuizQuestion {
  question: string;
  question_type: DbQuestionType;
  options: string[] | null;
  correct_answer: string;
  explanation: string | null;
}

export interface ValidatedFlashcard {
  front: string;
  back: string;
}

/**
 * Validate and sanitize AI-generated quiz question fields.
 * AXO-126: Now accepts questionType and validates structure + correct_answer.
 * Throws if required fields are missing or structure is invalid.
 */
export function validateQuizQuestion(
  g: Record<string, unknown>,
  questionType: DbQuestionType,
): ValidatedQuizQuestion {
  const question = sanitizeTextField(g.question, MAX_QUESTION_LENGTH);
  if (!question) throw new Error("AI generated empty question");

  const correct_answer = sanitizeTextField(g.correct_answer, MAX_OPTION_LENGTH);
  if (!correct_answer) throw new Error("AI generated empty correct_answer");

  let options = sanitizeOptions(g.options);

  // ── P1: Validate structure matches question_type ──────
  switch (questionType) {
    case "mcq": {
      if (!options || options.length < 2) {
        throw new Error("MCQ question must have at least 2 options");
      }
      // P0: Validate correct_answer against options
      const validatedAnswer = validateCorrectAnswerInOptions(correct_answer, options);
      return {
        question,
        question_type: questionType,
        options,
        correct_answer: validatedAnswer,
        explanation: sanitizeTextField(g.explanation, MAX_EXPLANATION_LENGTH),
      };
    }

    case "true_false": {
      // Ensure true/false has exactly 2 options; provide defaults if missing
      if (!options || options.length < 2) {
        options = ["Verdadero", "Falso"];
      } else {
        options = options.slice(0, 2);
      }
      const validatedAnswer = validateTrueFalseAnswer(correct_answer, options);
      return {
        question,
        question_type: questionType,
        options,
        correct_answer: validatedAnswer,
        explanation: sanitizeTextField(g.explanation, MAX_EXPLANATION_LENGTH),
      };
    }

    case "fill_blank":
    case "open":
      // These types don't use options
      return {
        question,
        question_type: questionType,
        options: null,
        correct_answer,
        explanation: sanitizeTextField(g.explanation, MAX_EXPLANATION_LENGTH),
      };

    default:
      // Fallback: treat as MCQ-like if options present
      return {
        question,
        question_type: questionType,
        options,
        correct_answer,
        explanation: sanitizeTextField(g.explanation, MAX_EXPLANATION_LENGTH),
      };
  }
}

/**
 * Validate and sanitize AI-generated flashcard fields.
 * Throws if required fields are missing after sanitization.
 */
export function validateFlashcard(g: Record<string, unknown>): ValidatedFlashcard {
  const front = sanitizeTextField(g.front, MAX_FLASHCARD_SIDE_LENGTH);
  if (!front) throw new Error('AI generated empty flashcard front');

  const back = sanitizeTextField(g.back, MAX_FLASHCARD_SIDE_LENGTH);
  if (!back) throw new Error('AI generated empty flashcard back');

  return { front, back };
}

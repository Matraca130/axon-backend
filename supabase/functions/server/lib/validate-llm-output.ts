/**
 * validate-llm-output.ts — Sanitize + validate AI-generated content before DB INSERT
 *
 * AI-001 FIX: Security audit 2026-03-18
 * AXO-119 FIX: MCQ correct_answer + question_type structural validation
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

// ── High-Level Validators ────────────────────────────────

export interface ValidatedQuizQuestion {
  question: string;
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
 * Throws if required fields are missing after sanitization.
 *
 * AXO-119 FIX: When questionType is provided, performs structural validation:
 * - MCQ: requires 2+ options, correct_answer must be valid letter (A-F)
 * - true_false: forces options to ["Verdadero", "Falso"], answer must be A or B
 * - fill_blank / open: clears options
 */
export function validateQuizQuestion(
  g: Record<string, unknown>,
  questionType?: DbQuestionType,
): ValidatedQuizQuestion {
  const question = sanitizeTextField(g.question, MAX_QUESTION_LENGTH);
  if (!question) throw new Error('AI generated empty question');

  let correct_answer = sanitizeTextField(g.correct_answer, MAX_OPTION_LENGTH);
  if (!correct_answer) throw new Error('AI generated empty correct_answer');

  let options = sanitizeOptions(g.options);

  // AXO-119: Structural validation based on question type
  if (questionType) {
    if (questionType === "mcq") {
      if (!options || options.length < 2) {
        throw new Error('MCQ question must have at least 2 options');
      }
      // Validate correct_answer letter is within range of options
      const answerLetters = options.map((_, i) => String.fromCharCode(65 + i));
      const normalizedAnswer = correct_answer.trim().toUpperCase().charAt(0);
      if (!answerLetters.includes(normalizedAnswer)) {
        correct_answer = answerLetters[0]; // default to "A"
      }
    } else if (questionType === "true_false") {
      options = ["Verdadero", "Falso"];
      const normalizedAnswer = correct_answer.trim().toUpperCase().charAt(0);
      if (normalizedAnswer !== "A" && normalizedAnswer !== "B") {
        // Try to infer from text content
        const lower = correct_answer.toLowerCase();
        if (lower.includes("falso") || lower === "false" || lower === "f" || lower === "b") {
          correct_answer = "B";
        } else {
          correct_answer = "A";
        }
      }
    } else if (questionType === "fill_blank" || questionType === "open") {
      options = null;
    }
  } else if (options && options.length > 0) {
    // Fallback: even without questionType, validate correct_answer against options
    const answerLetters = options.map((_, i) => String.fromCharCode(65 + i));
    const normalizedAnswer = correct_answer.trim().toUpperCase().charAt(0);
    if (!answerLetters.includes(normalizedAnswer)) {
      correct_answer = answerLetters[0];
    }
  }

  return {
    question,
    options,
    correct_answer,
    explanation: sanitizeTextField(g.explanation, MAX_EXPLANATION_LENGTH),
  };
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

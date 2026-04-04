/**
 * validate-llm-output.ts — Sanitize + validate AI-generated content before DB INSERT
 *
 * AI-001 FIX: Security audit 2026-03-18
 *
 * Strategy: Strip HTML tags from text fields. Quiz questions and flashcards
 * are plain text — they should NEVER contain HTML. The frontend renders
 * them via React textContent (not innerHTML), so HTML entities would
 * display literally. Stripping tags is the correct approach.
 */

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
 * P0 FIX (AXO-124): If options are present, correct_answer MUST match one of them.
 * Auto-corrects by finding a case-insensitive match or falling back to first option.
 */
export function validateQuizQuestion(g: Record<string, unknown>): ValidatedQuizQuestion {
  const question = sanitizeTextField(g.question, MAX_QUESTION_LENGTH);
  if (!question) throw new Error('AI generated empty question');

  let correct_answer = sanitizeTextField(g.correct_answer, MAX_OPTION_LENGTH);
  if (!correct_answer) throw new Error('AI generated empty correct_answer');

  const options = sanitizeOptions(g.options);

  // P0 FIX: Validate correct_answer against options array (MCQ)
  if (options && options.length > 0) {
    const exactMatch = options.includes(correct_answer);
    if (!exactMatch) {
      // Try case-insensitive match
      const lowerAnswer = correct_answer.toLowerCase().trim();
      const caseMatch = options.find(
        (opt) => opt.toLowerCase().trim() === lowerAnswer,
      );
      if (caseMatch) {
        correct_answer = caseMatch;
      } else {
        // Try prefix match (LLM sometimes returns "A" instead of "A) ...")
        const prefixMatch = options.find(
          (opt) => opt.toLowerCase().startsWith(lowerAnswer) ||
                   lowerAnswer.startsWith(opt.toLowerCase()),
        );
        if (prefixMatch) {
          correct_answer = prefixMatch;
        } else {
          // Last resort: use first option and warn
          console.warn(
            `[validate-llm-output] correct_answer "${correct_answer}" not in options ${JSON.stringify(options)}. Falling back to first option.`,
          );
          correct_answer = options[0];
        }
      }
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

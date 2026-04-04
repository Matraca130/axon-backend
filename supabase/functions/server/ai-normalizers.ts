/**
 * ai-normalizers.ts — Shared normalizers for AI-generated content → DB
 *
 * LLMs (Claude, Gemini, etc.) may return fields in formats that don't match
 * the database schema. These normalizers ensure type safety before INSERT.
 *
 * Used by: generate-smart.ts, generate.ts, pre-generate.ts
 *
 * Design principles:
 *   - Accept BOTH formats (string and integer) for backward compat
 *   - Safe defaults: unknown values → medium difficulty, mcq type
 *   - Pure functions, no side effects, no async
 *   - Defense-in-depth: prompts ask for correct format + normalizers as safety net
 */

// ── Valid DB values ───────────────────────────────────────

/** DB column quiz_questions.question_type: text enum */
export type DbQuestionType = "mcq" | "true_false" | "fill_blank" | "open";

/** DB column quiz_questions.difficulty: integer 1/2/3 */
export type DbDifficulty = 1 | 2 | 3;

// ── Difficulty: string → integer ─────────────────────────

const DIFFICULTY_STR_TO_INT: Record<string, DbDifficulty> = {
  easy: 1,
  facil: 1,
  medium: 2,
  media: 2,
  medio: 2,
  hard: 3,
  dificil: 3,
  difficult: 3,
};

/**
 * Normalize difficulty from LLM output to DB integer.
 *
 * Accepts:
 *   - number 1/2/3 → pass through
 *   - string "easy"/"medium"/"hard" → map to 1/2/3
 *   - string "facil"/"media"/"dificil" (Spanish) → map to 1/2/3
 *   - anything else → default 2 (medium)
 */
export function normalizeDifficulty(d: unknown): DbDifficulty {
  if (typeof d === "number") {
    if (d === 1 || d === 2 || d === 3) return d;
    if (d <= 1) return 1;
    if (d >= 3) return 3;
    return Math.round(d) as DbDifficulty;
  }
  if (typeof d === "string") {
    return DIFFICULTY_STR_TO_INT[d.toLowerCase().trim()] ?? 2;
  }
  return 2; // default medium
}

// ── Question type: LLM variants → DB enum ────────────────

const QUESTION_TYPE_MAP: Record<string, DbQuestionType> = {
  // MCQ variants
  mcq: "mcq",
  multiple_choice: "mcq",
  multiplechoice: "mcq",
  opcion_multiple: "mcq",
  // True/False variants
  true_false: "true_false",
  truefalse: "true_false",
  verdadero_falso: "true_false",
  // Fill blank variants
  fill_blank: "fill_blank",
  fillblank: "fill_blank",
  fill_in_the_blank: "fill_blank",
  completar: "fill_blank",
  // Open variants
  open: "open",
  open_ended: "open",
  abierta: "open",
  respuesta_abierta: "open",
};

/**
 * Normalize question_type from LLM output to DB enum.
 *
 * Accepts any reasonable LLM variation (English/Spanish, with/without
 * underscores/spaces) and maps to the 4 valid DB enum values.
 * Unknown values default to "mcq".
 */
export function normalizeQuestionType(qt: unknown): DbQuestionType {
  if (typeof qt !== "string") return "mcq";
  const normalized = qt.toLowerCase().trim().replace(/[\s-]+/g, "_");
  return QUESTION_TYPE_MAP[normalized] ?? "mcq";
}

// ── Question type ↔ structure validation (P1 FIX AXO-124) ───

const TRUE_FALSE_VALUES = new Set([
  "true", "false", "verdadero", "falso", "v", "f", "t", "si", "no",
]);

/**
 * Infer the actual question type from the structure of the LLM output.
 *
 * Rules:
 *   - No options (or empty) → "open" or "fill_blank" (keep declared type if compatible)
 *   - Exactly 2 options that look like true/false → "true_false"
 *   - 3+ options → "mcq"
 *
 * P1 FIX (AXO-124): The LLM may declare question_type: "mcq" but provide a
 * true/false structure (or vice versa). This function detects the mismatch
 * and returns the type that matches the actual data.
 */
export function inferQuestionTypeFromStructure(
  g: Record<string, unknown>,
): DbQuestionType | null {
  const options = g.options;
  if (!Array.isArray(options) || options.length === 0) {
    // No options → compatible with open, fill_blank
    return null; // can't infer, let declared type stand
  }

  const validOptions = options.filter(
    (o) => typeof o === "string" && o.trim() !== "",
  );

  if (validOptions.length === 0) return null;

  // Check if it looks like true/false
  if (validOptions.length === 2) {
    const bothTrueFalse = validOptions.every(
      (o) => TRUE_FALSE_VALUES.has((o as string).toLowerCase().trim()),
    );
    if (bothTrueFalse) return "true_false";
  }

  // 2+ options with non-true/false content → mcq
  return "mcq";
}

/**
 * Validate that question_type matches the structure. If there's a mismatch,
 * return the corrected type. If consistent, return the declared type.
 */
export function reconcileQuestionType(
  declaredType: DbQuestionType,
  g: Record<string, unknown>,
): DbQuestionType {
  const inferred = inferQuestionTypeFromStructure(g);

  // If we can't infer from structure, trust the declared type
  if (inferred === null) {
    // But if declared type is "mcq" or "true_false" and there are no options,
    // that's a mismatch — downgrade to "open"
    const options = g.options;
    const hasOptions = Array.isArray(options) && options.some(
      (o) => typeof o === "string" && o.trim() !== "",
    );
    if ((declaredType === "mcq" || declaredType === "true_false") && !hasOptions) {
      console.warn(
        `[ai-normalizers] question_type "${declaredType}" but no options provided. Correcting to "open".`,
      );
      return "open";
    }
    return declaredType;
  }

  // If inferred matches declared, all good
  if (inferred === declaredType) return declaredType;

  // Mismatch: trust the structure over the declared type
  console.warn(
    `[ai-normalizers] question_type mismatch: declared "${declaredType}" but structure looks like "${inferred}". Correcting to "${inferred}".`,
  );
  return inferred;
}

// ── High-level sanitizer ─────────────────────────────────

export interface SanitizedQuizFields {
  question_type: DbQuestionType;
  difficulty: DbDifficulty;
}

/**
 * Sanitize all AI-generated quiz question fields that need normalization.
 * Call this on the parsed LLM JSON before DB insert.
 *
 * P1 FIX (AXO-124): Now also reconciles question_type against actual structure.
 *
 * Usage:
 *   const g = parseClaudeJson(result.text);
 *   const safe = sanitizeQuizFields(g);
 *   await db.from("quiz_questions").insert({
 *     ...otherFields,
 *     question_type: safe.question_type,
 *     difficulty: safe.difficulty,
 *   });
 */
export function sanitizeQuizFields(g: Record<string, unknown>): SanitizedQuizFields {
  const declaredType = normalizeQuestionType(g.question_type);
  return {
    question_type: reconcileQuestionType(declaredType, g),
    difficulty: normalizeDifficulty(g.difficulty),
  };
}

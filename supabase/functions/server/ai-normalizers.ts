/**
 * ai-normalizers.ts — Shared normalizers for AI-generated content → DB
 *
 * Gemini (and other LLMs) may return fields in formats that don't match
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
 * Normalize difficulty from Gemini output to DB integer.
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
 * Normalize question_type from Gemini output to DB enum.
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

// ── High-level sanitizer ─────────────────────────────────

export interface SanitizedQuizFields {
  question_type: DbQuestionType;
  difficulty: DbDifficulty;
}

/**
 * Sanitize all AI-generated quiz question fields that need normalization.
 * Call this on the parsed Gemini JSON before DB insert.
 *
 * Usage:
 *   const g = parseGeminiJson(result.text);
 *   const safe = sanitizeQuizFields(g);
 *   await db.from("quiz_questions").insert({
 *     ...otherFields,
 *     question_type: safe.question_type,
 *     difficulty: safe.difficulty,
 *   });
 */
export function sanitizeQuizFields(g: Record<string, unknown>): SanitizedQuizFields {
  return {
    question_type: normalizeQuestionType(g.question_type),
    difficulty: normalizeDifficulty(g.difficulty),
  };
}

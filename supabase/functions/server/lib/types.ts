/**
 * ============================================================
 * lib/types.ts — Tipos compartidos FSRS v4 Petrick + BKT v4
 *
 * TARGET: supabase/functions/server/lib/types.ts
 * DEPENDENCIAS: ZERO (pure types, no imports)
 * SPEC: axon-evaluation-spec.md v4.2
 *
 * Fase 1 del plan v3.7 — implementación canónica
 * ============================================================
 */

// ─── FSRS Card States ────────────────────────────────────────

export type FsrsCardState = "new" | "learning" | "review" | "relearning";

/**
 * @deprecated Legacy alias for FE parity. A numeric `FsrsState = 0|1|2|3`
 * existed in the FE types/platform.ts and had no runtime consumers.
 * Canonical FE type is now the same string union (FsrsState = FsrsCardState).
 * Kept here for eventual shared-package export.
 */
export type FsrsState = FsrsCardState;

// ─── FSRS Grade ──────────────────────────────────────────────
//
// MIRROR of frontend lib/grade-mapper.ts (FsrsGrade, FSRS_GRADE_TO_FLOAT)
// — keep in sync. FE↔BE don't share imports; numeric values MUST match
// byte-for-byte. Phase 2 will extract a shared package.
// Grade discreto 1-4 (formato FSRS standard para transporte)
// Mapping interno a continuo: 1->0.0(Again), 2->0.35(Hard), 3->0.65(Good), 4->1.0(Easy)

export type FsrsGrade = 1 | 2 | 3 | 4;

// Mapping function (spec v4.2, seccion 6.1, A3):
// "Escala de grades estandarizada: Again=0.0, Hard=0.35, Good=0.65, Easy=1.0"
export const GRADE_TO_FLOAT: Record<FsrsGrade, number> = {
  1: 0.00, // Again
  2: 0.35, // Hard
  3: 0.65, // Good
  4: 1.00, // Easy
};

// ─── FSRS Weights (18 params, spec v4.2) ─────────────────────
// IMPORTANTE: la numeracion w11-w14 corresponde a PLS, NO son "reserved"

export interface FsrsWeights {
  w0: number; // Initial stability for Again (spec: 1.0d)
  w1: number; // Initial stability for Hard (spec: 2.0d)
  w2: number; // Initial stability for Good (spec: 3.0d)
  w3: number; // Initial stability for Easy (spec: 6.0d)
  w4: number; // Initial difficulty D_0 (spec: 5.0)
  w5: number; // Difficulty mean-reversion strength (spec: 0.94)
  w6: number; // Difficulty grade sensitivity (spec: 0.86)
  w7: number; // (reserved)
  w8: number; // Recall stability: base growth (spec v4.2: 1.10)
  w9: number; // Recall stability: stability decay exponent (spec v4.2: 0.30)
  w10: number; // Recall stability: R sensitivity (spec v4.2: 0.90)
  w11: number; // PLS: scale factor (spec: 2.18) — NOT reserved!
  w12: number; // PLS: difficulty exponent (spec: 0.05)
  w13: number; // PLS: old-stability exponent (spec: 0.34)
  w14: number; // PLS: retrievability impact (spec: 1.26)
  w15: number; // Grade multiplier: Hard (spec: 0.29)
  w16: number; // Grade multiplier: Easy (spec: 2.61)
  w17: number; // (reserved / recovery floor)
}

// ─── FSRS Input / Output ─────────────────────────────────────

export interface FsrsV4Input {
  // Estado actual de la card (de fsrs_states table o defaults)
  currentStability: number; // fsrs_states.stability (default: depende de grade)
  currentDifficulty: number; // fsrs_states.difficulty (default: 5.0)
  currentReps: number; // fsrs_states.reps (default: 0)
  currentLapses: number; // fsrs_states.lapses (default: 0)
  currentState: FsrsCardState; // fsrs_states.state (default: "new")
  lastReviewAt: string | null; // fsrs_states.last_review_at (null si primera vez)

  // Input del review actual
  grade: FsrsGrade; // del review item (1-4)

  // BKT cross-signal
  isRecovering: boolean; // de BKT: max_p_know > RECOVERY_THRESHOLD && p_know < max_p_know

  // Optional: override weights (futuro: de algorithm_config)
  weights?: Partial<FsrsWeights>;

  // Optional: override "now" for testing determinism
  now?: Date;
}

export interface FsrsV4Output {
  stability: number;
  difficulty: number;
  due_at: string; // ISO timestamp
  reps: number;
  lapses: number;
  state: FsrsCardState;
  last_review_at: string; // ISO timestamp (now)
  retrievability: number; // R al momento del review (para logs/debug)
}

// ─── BKT Input / Output ─────────────────────────────────────

export interface BktV4Input {
  currentMastery: number; // bkt_states.p_know (0-1, default 0)
  maxReachedMastery: number; // bkt_states.max_p_know (0-1, null -> 0)
  isCorrect: boolean; // grade >= 3 (Good+ es correcto; Again y Hard son incorrecto)
  instrumentType: "flashcard" | "quiz";
}

export interface BktV4Output {
  p_know: number; // new mastery (0-1)
  max_p_know: number; // max(maxReachedMastery, p_know)
  delta: number; // p_know_new - p_know_old
  is_recovering: boolean; // was recovery factor applied?
}

// ─── BKT Constants (exported for testing) ────────────────────

export const BKT_PARAMS = {
  P_LEARN: 0.18, // Probabilidad de aprender por intento
  P_FORGET: 0.25, // Factor de olvido: mastery retiene 75%
  RECOVERY_FACTOR: 3.0, // Turbo boost para recuperar terreno perdido
  MIN_MASTERY_FOR_RECOVERY: 0.50, // Solo se activa si ya demostro dominio real
  QUIZ_MULTIPLIER: 0.70, // Quiz: reconocimiento (peso menor)
  FLASHCARD_MULTIPLIER: 1.00, // Flashcard: produccion (peso completo)
} as const;

// ─── BKT Weight Propagation (spec §4.2) ─────────────────────
// When a student reviews an item, the BKT mastery update propagates
// to linked keyword subtopics with these weights:
//   keyword_direct → full weight (1.0)
//   flashcard review → partial weight (0.3)
//   quiz review → partial weight (0.5)
export const BKT_WEIGHTS = {
  keyword_direct: 1.0,
  flashcard: 0.3,
  quiz: 0.5,
} as const;

// ─── isCorrect Thresholds (spec §6.1, critico) ──────────────
// FSRS: Hard (grade=2) IS successful recall (w15=0.29 reduces growth, but S still grows)
// BKT:  grade >= 3 is correct (only Good and Easy)
// Exam: grade >= 2 is correct (Hard+ = acierto para bonus)

export const THRESHOLDS = {
  BKT_CORRECT_MIN_GRADE: 3 as FsrsGrade, // Good+ = correct for BKT
  EXAM_CORRECT_MIN_GRADE: 2 as FsrsGrade, // Hard+ = correct for exam bonus
  FSRS_LAPSE_MAX_GRADE: 1 as FsrsGrade, // Only Again triggers lapse
} as const;

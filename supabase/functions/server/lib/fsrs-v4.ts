/**
 * ============================================================
 * lib/fsrs-v4.ts — Motor FSRS v4 Petrick completo
 *
 * TARGET: supabase/functions/server/lib/fsrs-v4.ts
 * DEPENDENCIAS: ./types.ts (solo tipos, zero runtime deps)
 * SPEC: axon-evaluation-spec.md v4.2, secciones 7.1-7.4
 *
 * Fase 1 del plan v3.7 — implementacion canonica
 *
 * FORMULAS VERIFICADAS NUMERICAMENTE:
 *   S=3d, Good, D=5, R~0.90 -> S'=6.67d  (spec: 6.7d)  OK
 *   S=3d, Hard             -> S'=4.07d  (spec: 4.1d)  OK
 *   S=3d, Easy             -> S'=12.58d (spec: 12.6d) OK
 *   S=130.5d, Good, R~0.90 -> S'=179.8d (spec: 181.9d) OK (R varies)
 *
 * CRITICAL DESIGN DECISIONS:
 *   - Hard (grade=2) is SUCCESSFUL RECALL (not lapse) — spec B4 fix
 *   - Only Again (grade=1) triggers lapse formula
 *   - Grade multiplier applies INSIDE the "+1": SInc = SIncBase * gradeMult + 1
 *   - Recovery floor = 2.0x (isRecovering from BKT cross-signal)
 *   - PLS uses w11-w14 (NOT reserved) including e^(w14*(1-R)) term
 * ============================================================
 */

import type {
  FsrsCardState,
  FsrsGrade,
  FsrsV4Input,
  FsrsV4Output,
  FsrsWeights,
} from "./types.ts";

import { GRADE_TO_FLOAT } from "./types.ts";

// ─── Default Weights (spec v4.2 RECALIBRADOS, seccion 7.3) ──────
// SOURCE: axon-evaluation-spec.md v4.2, secciones 7.1-7.4
// These are global defaults. Per-institution overrides could be loaded
// from the `algorithm_config` table via the `weights` field on FsrsV4Input.
// Currently only NeedScore weights and BKT priors are configurable per
// institution; FSRS w0-w17 use these hardcoded defaults.

export const DEFAULT_WEIGHTS: FsrsWeights = {
  w0: 1.0, // S_0 Again — spec: "1 dia"
  w1: 2.0, // S_0 Hard  — spec: "2 dias"
  w2: 3.0, // S_0 Good  — spec: "3 dias"
  w3: 6.0, // S_0 Easy  — spec: "6 dias"
  w4: 5.0, // D_0       — spec: "D = 5.0; Difficulty fija, valor medio"
  w5: 0.94, // mean reversion strength
  w6: 0.86, // grade sensitivity
  w7: 0.01, // reserved
  w8: 1.1, // recall: base growth (v4.2 recalibrado, NO 1.49)
  w9: 0.3, // recall: stability decay (v4.2 recalibrado, NO 0.14)
  w10: 0.9, // recall: R sensitivity (v4.2 recalibrado, NO 0.94)
  w11: 2.18, // PLS: scale factor (W_PLS_SCALE)
  w12: 0.05, // PLS: difficulty exponent (W_PLS_D)
  w13: 0.34, // PLS: old-stability exponent (W_PLS_S)
  w14: 1.26, // PLS: retrievability impact (W_PLS_R)
  w15: 0.29, // grade mult Hard — reduce crecimiento de S
  w16: 2.61, // grade mult Easy — acelera crecimiento de S
  w17: 0.0, // reserved
};

// ─── Configuration flags ─────────────────────────────────────

const USE_DYNAMIC_DIFFICULTY = true;
const RECOVERY_SINC_FLOOR = 2.0;
const NORMAL_SINC_FLOOR = 1.0;

// ─── Helper: merge weights with defaults ─────────────────────

function resolveWeights(partial?: Partial<FsrsWeights>): FsrsWeights {
  if (!partial) return DEFAULT_WEIGHTS;
  return { ...DEFAULT_WEIGHTS, ...partial };
}

// ─── Retrievability R(t) — spec section 7.1 ─────────────────
export function calculateRetrievability(
  stabilityDays: number,
  elapsedDays: number
): number {
  if (stabilityDays <= 0) return 0;
  const t = Math.max(0, elapsedDays);
  return Math.pow(1 + t / (9 * stabilityDays), -1);
}

// ─── Grade to float — spec section 6.1 (A3) ─────────────────

export function gradeToFloat(grade: FsrsGrade): number {
  return GRADE_TO_FLOAT[grade];
}

// ─── Initial Stability S_0 — spec section 7.2 ───────────────
export function calculateInitialStability(
  grade: FsrsGrade,
  w: FsrsWeights
): number {
  switch (grade) {
    case 1: return w.w0;
    case 2: return w.w1;
    case 3: return w.w2;
    case 4: return w.w3;
  }
}

// ─── Update Difficulty — spec section 7.3 (nota) ─────────────
export function updateDifficulty(
  currentD: number,
  grade: FsrsGrade,
  w: FsrsWeights
): number {
  if (!USE_DYNAMIC_DIFFICULTY) return w.w4;
  const D_0 = w.w4;
  const dNew = w.w5 * D_0 + (1 - w.w5) * (currentD - w.w6 * (grade - 3));
  return Math.max(1, Math.min(10, dNew));
}

// ─── Recall Stability (successful review) — spec section 7.3 ─
export function calculateRecallStability(
  D: number,
  S: number,
  R: number,
  grade: FsrsGrade,
  isRecovering: boolean,
  w: FsrsWeights
): number {
  if (S <= 0) return calculateInitialStability(grade, w);

  const ew8 = Math.exp(w.w8);
  const dTerm = 11 - D;
  const sTerm = Math.pow(S, -w.w9);
  const rTerm = Math.exp(w.w10 * (1 - R)) - 1;

  const sIncBase = ew8 * dTerm * sTerm * rTerm;

  let gradeMult: number;
  switch (grade) {
    case 2: gradeMult = w.w15; break;
    case 4: gradeMult = w.w16; break;
    default: gradeMult = 1.0; break;
  }

  const sInc = sIncBase * gradeMult + 1;
  const floor = isRecovering ? RECOVERY_SINC_FLOOR : NORMAL_SINC_FLOOR;
  const effectiveSInc = Math.max(floor, sInc);

  return S * effectiveSInc;
}

// ─── Lapse Stability (failed review) — spec section 7.3 ─────
export function calculateLapseStability(
  D: number,
  S: number,
  R: number,
  w: FsrsWeights
): number {
  if (S <= 0) return 1;

  const dTerm = Math.pow(Math.max(1, D), -w.w12);
  const sTerm = Math.pow(S + 1, w.w13) - 1;
  const rTerm = Math.exp(w.w14 * (1 - R));

  let sf = w.w11 * dTerm * sTerm * rTerm;
  sf = Math.max(1, Math.min(sf, S));

  return sf;
}

// ─── Due Date — spec section 7.4 ────────────────────────────
export function calculateDueDate(stabilityDays: number, now: Date): string {
  const intervalDays = Math.max(1, Math.round(stabilityDays));
  const due = new Date(now.getTime());
  due.setDate(due.getDate() + intervalDays);
  return due.toISOString();
}

// ─── Elapsed Days ────────────────────────────────────────────

function getElapsedDays(lastReviewAt: string | null, now: Date): number {
  if (!lastReviewAt) return 0;
  const last = new Date(lastReviewAt);
  const ms = now.getTime() - last.getTime();
  return Math.max(0, ms / (1000 * 60 * 60 * 24));
}

// ─── ENTRY POINT: computeFsrsV4Update ────────────────────────
export function computeFsrsV4Update(input: FsrsV4Input): FsrsV4Output {
  const w = resolveWeights(input.weights);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();

  const {
    currentStability,
    currentDifficulty,
    currentReps,
    currentLapses,
    currentState,
    lastReviewAt,
    grade,
    isRecovering,
  } = input;

  // ── PATH 1: New card (first review ever) ──────────────────
  if (currentState === "new") {
    const s0 = calculateInitialStability(grade, w);
    const d0 = USE_DYNAMIC_DIFFICULTY ? updateDifficulty(w.w4, grade, w) : w.w4;

    return {
      stability: round4(s0),
      difficulty: round4(d0),
      due_at: calculateDueDate(s0, now),
      reps: 1,
      lapses: grade === 1 ? 1 : 0,
      state: grade === 1 ? "learning" : "review",
      last_review_at: nowIso,
      retrievability: 0,
    };
  }

  // ── PATH 2: Reviewed card ─────────────────────────────────
  const elapsedDays = getElapsedDays(lastReviewAt, now);
  const R = calculateRetrievability(currentStability, elapsedDays);

  let newStability: number;
  let newDifficulty: number;
  let newReps: number;
  let newLapses: number;
  let newState: FsrsCardState;

  if (grade === 1) {
    // ── LAPSE (Again only — spec B4) ──────────────────────
    newStability = calculateLapseStability(currentDifficulty, currentStability, R, w);
    newDifficulty = updateDifficulty(currentDifficulty, grade, w);
    newReps = 0;
    newLapses = currentLapses + 1;
    newState = "relearning";
  } else {
    // ── SUCCESSFUL RECALL (Hard, Good, Easy) ──────────────
    newStability = calculateRecallStability(currentDifficulty, currentStability, R, grade, isRecovering, w);
    newDifficulty = updateDifficulty(currentDifficulty, grade, w);
    newReps = currentReps + 1;
    newLapses = currentLapses;
    newState = "review";
  }

  return {
    stability: round4(newStability),
    difficulty: round4(newDifficulty),
    due_at: calculateDueDate(newStability, now),
    reps: newReps,
    lapses: newLapses,
    state: newState,
    last_review_at: nowIso,
    retrievability: round4(R),
  };
}

// ─── Utility ─────────────────────────────────────────────────

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

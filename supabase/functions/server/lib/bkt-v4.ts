/**
 * ============================================================
 * lib/bkt-v4.ts — Motor BKT v4 con Recovery activo
 *
 * TARGET: supabase/functions/server/lib/bkt-v4.ts
 * DEPENDENCIAS: ./types.ts (solo tipos + constantes, zero runtime deps)
 * SPEC: axon-evaluation-spec.md v4.2, seccion 6.1
 *
 * Fase 1 del plan v3.7 — implementacion canonica
 *
 * FORMULAS (spec seccion 6.1):
 *   Correcto:  new = cur + (1-cur) * P_LEARN * typeMult * recoveryMult
 *   Incorrecto: new = cur * (1 - P_FORGET)  = cur * 0.75
 *
 * CRITICAL: isCorrect threshold for BKT is grade >= 3 (Good+)
 *   Hard (grade=2) is INCORRECT for BKT (but successful recall for FSRS)
 *
 * RECOVERY (spec seccion 6.1):
 *   When max_p_know > MIN_MASTERY_FOR_RECOVERY (0.50)
 *   AND current p_know < max_p_know (student KNEW but FORGOT):
 *   -> Apply RECOVERY_FACTOR (3.0x) — relearning is 3x faster
 * ============================================================
 */

import type { BktV4Input, BktV4Output } from "./types.ts";
import { BKT_PARAMS } from "./types.ts";

// ─── Recovery Multiplier — spec section 6.1 ─────────────────
export function calculateRecoveryMultiplier(
  currentMastery: number,
  maxReachedMastery: number
): { multiplier: number; isRecovering: boolean } {
  if (
    maxReachedMastery > BKT_PARAMS.MIN_MASTERY_FOR_RECOVERY &&
    currentMastery < maxReachedMastery
  ) {
    return { multiplier: BKT_PARAMS.RECOVERY_FACTOR, isRecovering: true };
  }
  return { multiplier: 1.0, isRecovering: false };
}

// ─── Type Multiplier — spec section 6.1 ─────────────────────
export function getTypeMultiplier(
  instrumentType: "flashcard" | "quiz"
): number {
  return instrumentType === "quiz"
    ? BKT_PARAMS.QUIZ_MULTIPLIER
    : BKT_PARAMS.FLASHCARD_MULTIPLIER;
}

// ─── Update Mastery — spec section 6.1 ──────────────────────
export function updateMastery(
  currentMastery: number,
  isCorrect: boolean,
  typeMultiplier: number,
  recoveryMultiplier: number
): number {
  let newMastery: number;

  if (isCorrect) {
    const gain =
      (1 - currentMastery) *
      BKT_PARAMS.P_LEARN *
      typeMultiplier *
      recoveryMultiplier;
    newMastery = currentMastery + gain;
  } else {
    newMastery = currentMastery * (1 - BKT_PARAMS.P_FORGET);
  }

  return Math.max(0, Math.min(1, newMastery));
}

// ─── Update Max Mastery ──────────────────────────────────────
export function updateMaxMastery(
  currentMax: number,
  newMastery: number
): number {
  return Math.max(currentMax, newMastery);
}

// ─── ENTRY POINT: computeBktV4Update ─────────────────────────
export function computeBktV4Update(input: BktV4Input): BktV4Output {
  const { currentMastery, maxReachedMastery, isCorrect, instrumentType } = input;

  const cur = Math.max(0, Math.min(1, currentMastery));
  const maxM = Math.max(0, Math.min(1, maxReachedMastery));

  const recovery = calculateRecoveryMultiplier(cur, maxM);
  const typeMult = getTypeMultiplier(instrumentType);
  const newMastery = updateMastery(cur, isCorrect, typeMult, recovery.multiplier);
  const newMax = updateMaxMastery(maxM, newMastery);
  const delta = round4(newMastery - cur);

  return {
    p_know: round4(newMastery),
    max_p_know: round4(newMax),
    delta,
    is_recovering: recovery.isRecovering,
  };
}

// ─── Display Mastery (spec section 7.1 + 7.4) ───────────────
export function calculateDisplayMastery(
  mastery: number,
  retrievability: number
): number {
  return Math.max(0, Math.min(1, mastery * retrievability));
}

// ─── Utility ─────────────────────────────────────────────────

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

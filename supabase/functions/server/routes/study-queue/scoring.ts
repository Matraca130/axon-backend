/**
 * routes/study-queue/scoring.ts — Study queue scoring algorithms
 *
 * Extracted from routes-study-queue.ts (PR #103).
 * Contains pure functions for NeedScore, retention, and mastery color.
 *
 * v4.2 spec compliance:
 *   - clinical_priority from keywords (exponential NeedScore scaling)
 *   - 5-color scale: red/orange/yellow/green/blue with relative Δ mode
 *   - Domination threshold: 0.70 + (priority × 0.20)
 *
 * Exports:
 *   NEED_CONFIG           — NeedScore weights
 *   NeedScoreInput        — Input type for calculateNeedScore
 *   calculateNeedScore    — Weighted priority score calculation
 *   calculateRetention    — FSRS v4 power-law retention
 *   getMasteryColor       — 5-color scale with domination threshold
 *   getMotivation         — Mastery-based motivation tier (low/medium/high)
 */

// ─── NeedScore Configuration (v4.2) ────────────────────────────

export const NEED_CONFIG = {
  overdueWeight: 0.40,
  masteryWeight: 0.30,
  fragilityWeight: 0.20,
  noveltyWeight: 0.10,
  graceDays: 1,
};

// ─── Constants ────────────────────────────────────────────────

export const MAX_FALLBACK_FLASHCARDS = 10_000;
const DEFAULT_DOMINATION_BASE = 0.70;
const DEFAULT_DOMINATION_PRIORITY_SCALE = 0.20;

// ─── Types ───────────────────────────────────────────────────

export interface NeedScoreInput {
  dueAt: string | null;
  fsrsLapses: number;
  fsrsReps: number;
  fsrsState: string;
  fsrsStability: number;
  pKnow: number;
  clinicalPriority: number;
}

// ─── NeedScore Calculation ─────────────────────────────────────

export function calculateNeedScore(input: NeedScoreInput, now: Date): number {
  const { dueAt, fsrsLapses, fsrsReps, fsrsState, pKnow, clinicalPriority } = input;

  let overdue = 0;
  if (!dueAt) {
    overdue = 1.0;
  } else {
    const dueDate = new Date(dueAt);
    const daysOverdue = (now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysOverdue > 0) {
      overdue = 1 - Math.exp(-daysOverdue / NEED_CONFIG.graceDays);
    }
  }

  const needMastery = 1 - pKnow;
  const needFragility = Math.min(1, fsrsLapses / Math.max(1, fsrsReps + fsrsLapses + 1));
  const needNovelty = fsrsState === "new" ? 1.0 : 0.0;

  const baseScore =
    NEED_CONFIG.overdueWeight * overdue +
    NEED_CONFIG.masteryWeight * needMastery +
    NEED_CONFIG.fragilityWeight * needFragility +
    NEED_CONFIG.noveltyWeight * needNovelty;

  const priorityMultiplier = 1.0 + Math.pow(2.0, clinicalPriority * 2.0);

  return Math.max(0, baseScore * priorityMultiplier);
}

// ─── Retention: FSRS v4 power-law ───────────────────────────────

export function calculateRetention(
  lastReviewAt: string | null,
  stabilityDays: number,
  now: Date,
): number {
  if (!lastReviewAt || stabilityDays <= 0) return 0;
  const daysSince = (now.getTime() - new Date(lastReviewAt).getTime()) / (1000 * 60 * 60 * 24);
  return Math.max(0, Math.min(1, Math.pow(1 + daysSince / (9 * stabilityDays), -1)));
}

// ─── 5-Color Scale (§6.2) ─────────────────────────────────────

export function getMasteryColor(
  pKnow: number,
  retention: number,
  clinicalPriority: number,
): "blue" | "green" | "yellow" | "orange" | "red" | "gray" {
  if (pKnow <= 0) return "gray";

  const displayMastery = pKnow * (retention > 0 ? retention : (pKnow > 0 ? 1.0 : 0.0));
  const threshold = DEFAULT_DOMINATION_BASE + clinicalPriority * DEFAULT_DOMINATION_PRIORITY_SCALE;
  const delta = threshold > 0 ? displayMastery / threshold : 0;

  if (delta >= 1.10) return "blue";
  if (delta >= 1.00) return "green";
  if (delta >= 0.85) return "yellow";
  if (delta >= 0.50) return "orange";
  return "red";
}

// ─── Motivation Tier (§6.3) ──────────────────────────────────

export type MotivationTier = "low" | "medium" | "high";

/**
 * Maps a mastery fraction (0-1) to a motivation tier.
 * Boundaries: <0.30 → low, 0.30–0.70 → medium, >0.70 → high.
 * Used by adaptive generation prompts to calibrate difficulty.
 */
export function getMotivation(pKnow: number): MotivationTier {
  if (pKnow < 0.30) return "low";
  if (pKnow <= 0.70) return "medium";
  return "high";
}

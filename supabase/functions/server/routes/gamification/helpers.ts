/**
 * routes/gamification/helpers.ts — Shared gamification helpers
 *
 * Extracted from routes-gamification.tsx for modularization.
 * These functions are used across multiple gamification modules.
 *
 * Exports:
 *   evaluateSimpleCondition — Badge criteria parser
 *   calculateLevel — XP to level conversion
 *   LEVEL_THRESHOLDS — Level XP boundaries
 *   GOAL_BONUS_XP — Bonus XP per goal type
 *   FREEZE_COST_XP — Cost to buy a streak freeze
 *   REPAIR_BASE_COST_XP — Base cost for streak repair
 *   MAX_FREEZES — Maximum streak freezes a student can own
 */

// ─── Level Thresholds ─────────────────────────────────────────
// Keep in sync with xp-engine.ts and award_xp() RPC

export const LEVEL_THRESHOLDS: [number, number][] = [
  [10000, 12],
  [7500, 11],
  [5500, 10],
  [4000, 9],
  [3000, 8],
  [2200, 7],
  [1500, 6],
  [1000, 5],
  [600, 4],
  [300, 3],
  [100, 2],
];

export function calculateLevel(totalXp: number): number {
  for (const [threshold, level] of LEVEL_THRESHOLDS) {
    if (totalXp >= threshold) return level;
  }
  return 1;
}

// ─── Gamification Constants ──────────────────────────────────

/** Cost in XP to purchase one streak freeze */
export const FREEZE_COST_XP = 100;

/** Maximum number of streak freezes a student can own */
export const MAX_FREEZES = 3;

/** Base cost in XP to repair a broken streak */
export const REPAIR_BASE_COST_XP = 200;

/** Bonus XP awarded for completing each goal type */
export const GOAL_BONUS_XP: Record<string, number> = {
  review_due: 50,
  weak_area: 75,
  daily_xp: 25,
  study_time: 30,
  complete_session: 25,
};

// ─── Badge Criteria Evaluator ────────────────────────────────

/**
 * Evaluate a simple condition string against a data row.
 * Supports conditions like "total_xp >= 100", "current_streak > 7".
 *
 * Operators: >=, >, <=, <, =, ==
 * Values: numeric only (integers and decimals)
 * Missing fields default to 0.
 *
 * @param condition — Condition string (e.g. "total_xp >= 500")
 * @param row — Data object to evaluate against
 * @returns true if condition is met, false otherwise
 */
export function evaluateSimpleCondition(
  condition: string,
  row: Record<string, unknown>,
): boolean {
  const match = condition.match(
    /^(\w+)\s*(>=|>|<=|<|=|==)\s*([\d.]+)$/,
  );
  if (!match) return false;

  const [, field, op, valueStr] = match;
  const actual = Number(row[field] ?? 0);
  const target = parseFloat(valueStr);

  if (isNaN(actual) || isNaN(target)) return false;

  switch (op) {
    case ">=":
      return actual >= target;
    case ">":
      return actual > target;
    case "<=":
      return actual <= target;
    case "<":
      return actual < target;
    case "=":
    case "==":
      return actual === target;
    default:
      return false;
  }
}

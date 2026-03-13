/**
 * routes/gamification/helpers.ts — Shared gamification helpers
 *
 * Extracted from routes-gamification.tsx for modularization.
 * These functions are used across multiple gamification modules.
 *
 * Exports:
 *   evaluateSimpleCondition — Badge criteria parser
 *   calculateLevel — XP to level conversion (re-exported from xp-engine.ts)
 *   LEVEL_THRESHOLDS — Level XP boundaries (re-exported from xp-engine.ts)
 *   GOAL_BONUS_XP — Bonus XP per goal type
 *   FREEZE_COST_XP — Cost to buy a streak freeze
 *   REPAIR_BASE_COST_XP — Base cost for streak repair
 *   MAX_FREEZES — Maximum streak freezes a student can own
 *
 * PR #102: calculateLevel + LEVEL_THRESHOLDS now imported from xp-engine.ts
 *   (single source of truth, was duplicated before).
 */

// ─── Level Thresholds (single source of truth: xp-engine.ts) ──
// Re-exported so gamification modules can import from helpers.ts
// without knowing about xp-engine.ts internals.

export { calculateLevel, LEVEL_THRESHOLDS } from "../../xp-engine.ts";

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

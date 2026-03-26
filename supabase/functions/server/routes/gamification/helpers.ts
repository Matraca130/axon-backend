/**
 * routes/gamification/helpers.ts — Shared gamification helpers
 *
 * Extracted from routes-gamification.tsx for modularization.
 * These functions are used across multiple gamification modules.
 *
 * Exports:
 *   evaluateSimpleCondition — Badge criteria parser
 *   evaluateCountBadge — COUNT-based trigger_config evaluator (Sprint 3)
 *   calculateLevel — XP to level conversion (re-exported from xp-engine.ts)
 *   LEVEL_THRESHOLDS — Level XP boundaries (re-exported from xp-engine.ts)
 *   GOAL_BONUS_XP — Bonus XP per goal type
 *   FREEZE_COST_XP — Cost to buy a streak freeze
 *   REPAIR_BASE_COST_XP — Base cost for streak repair
 *   MAX_FREEZES — Maximum streak freezes a student can own
 *
 * PR #102: calculateLevel + LEVEL_THRESHOLDS now imported from xp-engine.ts
 *   (single source of truth, was duplicated before).
 *
 * Sprint 3:
 *   S3-001: evaluateCountBadge + applyTriggerFilter + TriggerConfig
 *   S3-002: Added fsrs_states to ALLOWED_TABLES (Recolector badges)
 *   S3-003: Fixed xp_collector slugs in migration (flashcards → fsrs_states)
 *   S3-004: Removed ai_conversations & leaderboard_weekly from ALLOWED_TABLES
 *           (tables don't exist in DB; 4 badges deactivated)
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js";

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

// ─── COUNT-Based Badge Evaluator (Sprint 3) ──────────────────
//
// Evaluates badges whose trigger_config uses COUNT(*), COUNT(DISTINCT col),
// or field comparisons (e.g. rank <= 10) against actual DB tables.
//
// Security:
//   - ALLOWED_TABLES whitelist prevents arbitrary table access
//   - Supabase client methods prevent SQL injection (no raw SQL)
//   - Filters parsed and applied via typed Supabase operators
//
// Supported trigger_config patterns:
//   {"table":"study_sessions","condition":"COUNT(*) >= 5","filter":"completed_at IS NOT NULL"}
//   {"table":"bkt_states","condition":"COUNT(*) >= 1","filter":"p_know > 0.80"}
//   {"table":"study_sessions","condition":"COUNT(DISTINCT summary_id) >= 25","filter":"..."}
//   {"table":"fsrs_states","condition":"COUNT(*) >= 10"}

export interface TriggerConfig {
  table: string;
  condition: string;
  filter?: string;
}

/**
 * Whitelist of tables the badge evaluator can query.
 * Maps table name → student identifier column.
 *
 * S3-002: Added fsrs_states for xp_collector badges.
 * S3-004: Removed ai_conversations & leaderboard_weekly (tables don't exist).
 *
 * TODO: When ai_conversations and leaderboard_weekly tables are created,
 *       re-add them here and reactivate the 4 deactivated badges:
 *         - ai_conversations: curioso_1, investigador_1
 *         - leaderboard_weekly: campeon_semanal, socializador
 *       Verify the correct student column name (student_id vs user_id)
 *       before adding.
 */
const ALLOWED_TABLES: Record<string, string> = {
  study_sessions: "student_id",
  reading_states: "student_id",
  bkt_states: "student_id",
  fsrs_states: "student_id",
};

/**
 * Evaluate a COUNT-based badge by querying the trigger table.
 *
 * @param db — Supabase admin client (bypasses RLS)
 * @param studentId — Student UUID
 * @param config — Parsed trigger_config from badge_definitions
 * @returns true if the badge condition is met
 */
export async function evaluateCountBadge(
  db: SupabaseClient,
  studentId: string,
  config: TriggerConfig,
): Promise<boolean> {
  const studentCol = ALLOWED_TABLES[config.table];
  if (!studentCol) {
    console.warn(
      `[Badge Eval] Table "${config.table}" not in whitelist, skipping`,
    );
    return false;
  }

  const { condition, filter } = config;

  // ── Pattern 1: COUNT(*) op N ──
  const countAllMatch = condition.match(
    /^COUNT\(\*\)\s*(>=|>|<=|<|=)\s*(\d+)$/,
  );
  if (countAllMatch) {
    const [, op, valStr] = countAllMatch;
    const target = parseInt(valStr, 10);

    // deno-lint-ignore no-explicit-any
    let query: any = db
      .from(config.table)
      .select("*", { count: "exact", head: true })
      .eq(studentCol, studentId);

    if (filter) query = applyTriggerFilter(query, filter);

    const { count, error } = await query;
    if (error) {
      console.error(
        `[Badge Eval] COUNT(*) query on ${config.table} failed:`,
        error.message,
      );
      return false;
    }

    return compareValues(count ?? 0, op, target);
  }

  // ── Pattern 2: COUNT(DISTINCT col) op N ──
  const countDistinctMatch = condition.match(
    /^COUNT\(DISTINCT\s+(\w+)\)\s*(>=|>|<=|<|=)\s*(\d+)$/,
  );
  if (countDistinctMatch) {
    const [, distinctCol, op, valStr] = countDistinctMatch;
    const target = parseInt(valStr, 10);

    // Fetch the distinct column values, then count unique in TS.
    // Safe for per-student data (typically < 1000 rows).
    // deno-lint-ignore no-explicit-any
    let query: any = db
      .from(config.table)
      .select(distinctCol)
      .eq(studentCol, studentId);

    if (filter) query = applyTriggerFilter(query, filter);

    const { data, error } = await query;
    if (error) {
      console.error(
        `[Badge Eval] COUNT(DISTINCT) query on ${config.table} failed:`,
        error.message,
      );
      return false;
    }

    const uniqueValues = new Set(
      (data ?? []).map((r: Record<string, unknown>) => r[distinctCol]),
    );
    return compareValues(uniqueValues.size, op, target);
  }

  // ── Pattern 3: field op N (e.g. "rank <= 10") ──
  // Check if ANY row for this student matches the condition.
  const fieldMatch = condition.match(
    /^(\w+)\s*(>=|>|<=|<|=)\s*(\d+)$/,
  );
  if (fieldMatch) {
    const [, field, op, valStr] = fieldMatch;
    const target = parseInt(valStr, 10);

    // deno-lint-ignore no-explicit-any
    let query: any = db
      .from(config.table)
      .select(field)
      .eq(studentCol, studentId);

    // Apply the condition directly as a Supabase filter
    switch (op) {
      case ">=":
        query = query.gte(field, target);
        break;
      case ">":
        query = query.gt(field, target);
        break;
      case "<=":
        query = query.lte(field, target);
        break;
      case "<":
        query = query.lt(field, target);
        break;
      case "=":
        query = query.eq(field, target);
        break;
    }

    if (filter) query = applyTriggerFilter(query, filter);

    const { data, error } = await query.limit(1);
    if (error) {
      console.error(
        `[Badge Eval] Field query on ${config.table}.${field} failed:`,
        error.message,
      );
      return false;
    }

    return (data ?? []).length > 0;
  }

  console.warn(
    `[Badge Eval] Unparseable condition: "${condition}"`,
  );
  return false;
}

// ─── Internal Helpers ────────────────────────────────────────

/**
 * Apply a trigger_config filter string to a Supabase query.
 * Supports:
 *   - "field IS NOT NULL"
 *   - "field IS NULL"
 *   - "field > 0.80" / "field >= 10" / "field = true"
 *   - Multiple conditions joined by " AND "
 */
// deno-lint-ignore no-explicit-any
function applyTriggerFilter(query: any, filter: string): any {
  const parts = filter.split(/\s+AND\s+/i).map((s) => s.trim());

  for (const part of parts) {
    // IS NOT NULL
    const isNotNull = part.match(/^(\w+)\s+IS\s+NOT\s+NULL$/i);
    if (isNotNull) {
      query = query.not(isNotNull[1], "is", null);
      continue;
    }

    // IS NULL
    const isNull = part.match(/^(\w+)\s+IS\s+NULL$/i);
    if (isNull) {
      query = query.is(isNull[1], null);
      continue;
    }

    // field op value
    const comp = part.match(/^(\w+)\s*(>=|>|<=|<|=)\s*(.+)$/);
    if (comp) {
      const [, field, op, rawVal] = comp;
      const val =
        rawVal === "true"
          ? true
          : rawVal === "false"
            ? false
            : parseFloat(rawVal);

      switch (op) {
        case ">=":
          query = query.gte(field, val);
          break;
        case ">":
          query = query.gt(field, val);
          break;
        case "<=":
          query = query.lte(field, val);
          break;
        case "<":
          query = query.lt(field, val);
          break;
        case "=":
          query = query.eq(field, val);
          break;
      }
      continue;
    }

    console.warn(`[Badge Eval] Unparseable filter part: "${part}"`);
  }

  return query;
}

/**
 * Compare two numeric values with a string operator.
 */
function compareValues(actual: number, op: string, target: number): boolean {
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
      return actual === target;
    default:
      return false;
  }
}

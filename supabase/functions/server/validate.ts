/**
 * validate.ts — Lightweight runtime validation for Axon v4.4
 *
 * Pure guard functions + declarative field validator.
 * Zero dependencies, zero Zod. Catches business-rule violations
 * that typeof alone cannot: empty strings, numeric ranges,
 * probability bounds, UUID format, date format.
 *
 * Usage:
 *   import { isUuid, isNonNeg, validateFields } from "./validate.ts";
 *
 *   // Quick guard
 *   if (!isUuid(body.session_id)) return err(c, "...", 400);
 *
 *   // Declarative batch (for optional fields)
 *   const { fields, error } = validateFields(body, [
 *     { key: "scroll_position", check: isNonNeg, msg: "must be ≥ 0" },
 *     { key: "completed",       check: isBool,   msg: "must be boolean" },
 *   ]);
 *   if (error) return err(c, error, 400);
 */

// ─── Type Guards ─────────────────────────────────────────────────────

export const isStr = (v: unknown): v is string => typeof v === "string";

/** Non-empty string (trims whitespace). Catches "" and "   ". */
export const isNonEmpty = (v: unknown): v is string =>
  isStr(v) && v.trim().length > 0;

export const isNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

export const isBool = (v: unknown): v is boolean => typeof v === "boolean";

export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// ─── Format Validators ──────────────────────────────────────────────

/** UUID v1-v5 format: 8-4-4-4-12 hex. */
export const isUuid = (v: unknown): v is string =>
  isStr(v) &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** Basic email format (not RFC 5322 — just "something@something.something"). */
export const isEmail = (v: unknown): v is string =>
  isStr(v) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 320;

/** ISO 8601 timestamp parseable by Date.parse(). */
export const isIsoTs = (v: unknown): v is string =>
  isStr(v) && v.length >= 10 && !isNaN(Date.parse(v));

/** Date-only string: YYYY-MM-DD. */
export const isDateOnly = (v: unknown): v is string =>
  isStr(v) && /^\d{4}-\d{2}-\d{2}$/.test(v);

// ─── Numeric Range Validators ───────────────────────────────────────

/** Finite number in [min, max]. */
export const inRange = (v: unknown, min: number, max: number): v is number =>
  isNum(v) && v >= min && v <= max;

/** Non-negative finite number (≥ 0). */
export const isNonNeg = (v: unknown): v is number => isNum(v) && v >= 0;

/** Non-negative integer (0, 1, 2, ...). */
export const isNonNegInt = (v: unknown): v is number =>
  isNum(v) && Number.isInteger(v) && v >= 0;

/** Probability value [0, 1]. */
export const isProbability = (v: unknown): v is number => inRange(v, 0, 1);

// ─── Enum Validator ─────────────────────────────────────────────────

/** Check that a string is one of the allowed values. */
export const isOneOf = <T extends string>(
  v: unknown,
  values: readonly T[],
): v is T => isStr(v) && (values as readonly string[]).includes(v);

// ─── Declarative Field Validator ────────────────────────────────────

export type FieldRule = {
  /** Property name in the body object */
  key: string;
  /** Guard function — return true if valid */
  check: (v: unknown) => boolean;
  /** Error message shown if check fails */
  msg: string;
  /** If true, field MUST be present and non-null */
  required?: boolean;
};

/**
 * Validate and pick fields from a request body.
 *
 * - Required fields: must be present and pass their check.
 * - Optional fields: if present, must pass their check. If absent, skipped.
 * - Returns validated `fields` to spread into a DB row, or `error` string.
 *
 * Example:
 *   const { fields, error } = validateFields(body, [
 *     { key: "summary_id", check: isUuid, msg: "summary_id must be a UUID", required: true },
 *     { key: "scroll_position", check: isNonNeg, msg: "scroll_position must be ≥ 0" },
 *   ]);
 *   if (error) return err(c, error, 400);
 *   // fields = { summary_id: "abc-123", scroll_position: 42 }
 */
export function validateFields(
  body: Record<string, unknown>,
  rules: FieldRule[],
): { fields: Record<string, unknown>; error: string | null } {
  const fields: Record<string, unknown> = {};
  for (const r of rules) {
    const v = body[r.key];
    if (v === undefined || v === null) {
      if (r.required) {
        return { fields, error: `Missing required field: ${r.key}` };
      }
      continue; // optional, not provided — skip
    }
    if (!r.check(v)) {
      return { fields, error: `${r.key}: ${r.msg}` };
    }
    fields[r.key] = v;
  }
  return { fields, error: null };
}

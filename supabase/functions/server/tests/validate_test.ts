/**
 * Tests for validate.ts — Pure unit tests for all guard functions.
 *
 * Run: deno test supabase/functions/server/tests/validate_test.ts
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isStr,
  isNonEmpty,
  isNum,
  isBool,
  isObj,
  isUuid,
  isEmail,
  isIsoTs,
  isDateOnly,
  inRange,
  isNonNeg,
  isNonNegInt,
  isProbability,
  isOneOf,
  validateFields,
} from "../validate.ts";

// ─── isStr ───────────────────────────────────────────────────────────
Deno.test("isStr: accepts strings", () => {
  assertEquals(isStr(""), true);
  assertEquals(isStr("hello"), true);
  assertEquals(isStr(123), false);
  assertEquals(isStr(null), false);
  assertEquals(isStr(undefined), false);
});

// ─── isNonEmpty ──────────────────────────────────────────────────────
Deno.test("isNonEmpty: rejects empty and whitespace-only strings", () => {
  assertEquals(isNonEmpty("hello"), true);
  assertEquals(isNonEmpty("  hello  "), true);
  assertEquals(isNonEmpty(""), false);
  assertEquals(isNonEmpty("   "), false);
  assertEquals(isNonEmpty("\t\n"), false);
  assertEquals(isNonEmpty(123), false);
  assertEquals(isNonEmpty(null), false);
});

// ─── isNum ───────────────────────────────────────────────────────────
Deno.test("isNum: accepts finite numbers, rejects Infinity/NaN", () => {
  assertEquals(isNum(0), true);
  assertEquals(isNum(-3.14), true);
  assertEquals(isNum(Number.MAX_SAFE_INTEGER), true);
  assertEquals(isNum(Infinity), false);
  assertEquals(isNum(-Infinity), false);
  assertEquals(isNum(NaN), false);
  assertEquals(isNum("5"), false);
});

// ─── isBool ──────────────────────────────────────────────────────────
Deno.test("isBool: only accepts true/false", () => {
  assertEquals(isBool(true), true);
  assertEquals(isBool(false), true);
  assertEquals(isBool(0), false);
  assertEquals(isBool(1), false);
  assertEquals(isBool("true"), false);
  assertEquals(isBool(null), false);
});

// ─── isObj ───────────────────────────────────────────────────────────
Deno.test("isObj: plain objects only, not arrays or null", () => {
  assertEquals(isObj({}), true);
  assertEquals(isObj({ a: 1 }), true);
  assertEquals(isObj([]), false);
  assertEquals(isObj(null), false);
  assertEquals(isObj("string"), false);
});

// ─── isUuid ──────────────────────────────────────────────────────────
Deno.test("isUuid: validates UUID v4 format", () => {
  assertEquals(isUuid("550e8400-e29b-41d4-a716-446655440000"), true);
  assertEquals(isUuid("ABCDEF00-1234-5678-ABCD-EF0123456789"), true);
  assertEquals(isUuid("not-a-uuid"), false);
  assertEquals(isUuid(""), false);
  assertEquals(isUuid("550e8400-e29b-41d4-a716-44665544000"), false); // too short
  assertEquals(isUuid(123), false);
  assertEquals(isUuid(null), false);
});

// ─── isEmail ─────────────────────────────────────────────────────────
Deno.test("isEmail: validates basic email format", () => {
  assertEquals(isEmail("user@example.com"), true);
  assertEquals(isEmail("a@b.c"), true);
  assertEquals(isEmail("user+tag@domain.co.uk"), true);
  assertEquals(isEmail("@domain.com"), false);
  assertEquals(isEmail("user@"), false);
  assertEquals(isEmail("no-at-sign"), false);
  assertEquals(isEmail(""), false);
  assertEquals(isEmail(123), false);
  // Max length check (320 chars)
  assertEquals(isEmail("a".repeat(310) + "@b.com"), true);
  assertEquals(isEmail("a".repeat(320) + "@b.com"), false);
});

// ─── isIsoTs ─────────────────────────────────────────────────────────
Deno.test("isIsoTs: validates ISO timestamps", () => {
  assertEquals(isIsoTs("2025-01-15T10:30:00Z"), true);
  assertEquals(isIsoTs("2025-01-15T10:30:00.000Z"), true);
  assertEquals(isIsoTs("2025-01-15"), true); // Date.parse accepts this
  assertEquals(isIsoTs("not-a-date"), false);
  assertEquals(isIsoTs(""), false);
  assertEquals(isIsoTs("short"), false); // length < 10
  assertEquals(isIsoTs(123), false);
});

// ─── isDateOnly ──────────────────────────────────────────────────────
Deno.test("isDateOnly: validates YYYY-MM-DD format", () => {
  assertEquals(isDateOnly("2025-01-15"), true);
  assertEquals(isDateOnly("2025-12-31"), true);
  assertEquals(isDateOnly("2025-1-15"), false);  // single digit month
  assertEquals(isDateOnly("2025-01-15T10:00"), false); // has time
  assertEquals(isDateOnly("01-15-2025"), false); // wrong order
  assertEquals(isDateOnly(""), false);
  assertEquals(isDateOnly(123), false);
});

// ─── inRange ─────────────────────────────────────────────────────────
Deno.test("inRange: inclusive boundaries", () => {
  assertEquals(inRange(0, 0, 5), true);
  assertEquals(inRange(5, 0, 5), true);
  assertEquals(inRange(2.5, 0, 5), true);
  assertEquals(inRange(-1, 0, 5), false);
  assertEquals(inRange(6, 0, 5), false);
  assertEquals(inRange(NaN, 0, 5), false);
  assertEquals(inRange(Infinity, 0, 5), false);
  assertEquals(inRange("3", 0, 5), false);
});

// ─── isNonNeg ────────────────────────────────────────────────────────
Deno.test("isNonNeg: non-negative numbers only", () => {
  assertEquals(isNonNeg(0), true);
  assertEquals(isNonNeg(0.001), true);
  assertEquals(isNonNeg(999), true);
  assertEquals(isNonNeg(-0.001), false);
  assertEquals(isNonNeg(-1), false);
  assertEquals(isNonNeg(NaN), false);
});

// ─── isNonNegInt ─────────────────────────────────────────────────────
Deno.test("isNonNegInt: non-negative integers only", () => {
  assertEquals(isNonNegInt(0), true);
  assertEquals(isNonNegInt(1), true);
  assertEquals(isNonNegInt(999), true);
  assertEquals(isNonNegInt(0.5), false);
  assertEquals(isNonNegInt(-1), false);
  assertEquals(isNonNegInt(1.1), false);
});

// ─── isProbability ───────────────────────────────────────────────────
Deno.test("isProbability: [0, 1] inclusive", () => {
  assertEquals(isProbability(0), true);
  assertEquals(isProbability(0.5), true);
  assertEquals(isProbability(1), true);
  assertEquals(isProbability(-0.001), false);
  assertEquals(isProbability(1.001), false);
  assertEquals(isProbability(NaN), false);
});

// ─── isOneOf ─────────────────────────────────────────────────────────
Deno.test("isOneOf: checks membership in array", () => {
  const states = ["new", "learning", "review"] as const;
  assertEquals(isOneOf("new", states), true);
  assertEquals(isOneOf("review", states), true);
  assertEquals(isOneOf("done", states), false);
  assertEquals(isOneOf("", states), false);
  assertEquals(isOneOf(123, states), false);
  assertEquals(isOneOf(null, states), false);
});

// ─── validateFields ──────────────────────────────────────────────────
Deno.test("validateFields: picks valid optional fields", () => {
  const body = { scroll_position: 42, time_spent: 100, completed: true };
  const { fields, error } = validateFields(body, [
    { key: "scroll_position", check: isNonNeg, msg: "must be ≥ 0" },
    { key: "completed", check: isBool, msg: "must be bool" },
    { key: "missing_field", check: isNonNeg, msg: "must be ≥ 0" },
  ]);

  assertEquals(error, null);
  assertEquals(fields.scroll_position, 42);
  assertEquals(fields.completed, true);
  assertEquals(fields.missing_field, undefined);
});

Deno.test("validateFields: returns error on invalid field", () => {
  const body = { scroll_position: -5 };
  const { error } = validateFields(body, [
    { key: "scroll_position", check: isNonNeg, msg: "must be ≥ 0" },
  ]);
  assertEquals(error, "scroll_position: must be ≥ 0");
});

Deno.test("validateFields: required fields must be present", () => {
  const body = {};
  const { error } = validateFields(body, [
    { key: "name", check: isNonEmpty, msg: "required", required: true },
  ]);
  assertEquals(error, "Missing required field: name");
});

Deno.test("validateFields: null treated as missing", () => {
  const body = { name: null };
  const { error } = validateFields(body, [
    { key: "name", check: isNonEmpty, msg: "required", required: true },
  ]);
  assertEquals(error, "Missing required field: name");
});

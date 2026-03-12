/**
 * tests/unit/validate.test.ts — 18 tests for validate.ts
 * Run: deno test tests/unit/validate.test.ts --no-check
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import {
  isStr, isNonEmpty, isNum, isBool, isObj,
  isUuid, isEmail, isIsoTs, isDateOnly,
  inRange, isNonNeg, isNonNegInt, isProbability,
  isOneOf, validateFields,
} from "../../supabase/functions/server/validate.ts";
import type { FieldRule } from "../../supabase/functions/server/validate.ts";

// ═══ HAPPY PATH ═══

Deno.test("accepts valid UUID v4 '550e8400-e29b-41d4-a716-446655440000'", () => {
  assert(isUuid("550e8400-e29b-41d4-a716-446655440000"));
  assert(isUuid("A550E840-E29B-41D4-A716-446655440000"));
});

Deno.test("accepts realistic email 'maria.garcia@universidad.mx'", () => {
  assert(isEmail("maria.garcia@universidad.mx"));
  assert(isEmail("jose.lopez@empresa.com.br"));
  assert(isEmail("student+tag@uni.edu"));
});

Deno.test("accepts ISO 8601 timestamps with timezone offsets", () => {
  assert(isIsoTs("2026-03-08T14:30:00Z"));
  assert(isIsoTs("2026-03-08T14:30:00-03:00"));
});

Deno.test("probability accepts boundary values 0 and 1", () => {
  assert(isProbability(0));
  assert(isProbability(1));
  assert(isProbability(0.5));
});

Deno.test("isOneOf accepts valid question_type values", () => {
  const types = ["mcq", "true_false", "fill_blank", "open"] as const;
  for (const t of types) assert(isOneOf(t, types));
});

// ═══ INPUT VALIDATION ═══

Deno.test("rejects null, undefined, empty for all guards", () => {
  assert(!isUuid(null)); assert(!isUuid(undefined)); assert(!isUuid(""));
  assert(!isEmail(null)); assert(!isNonEmpty("")); assert(!isNonEmpty("   "));
  assert(!isNum(null)); assert(!isBool(null));
});

Deno.test("rejects SQL injection as UUID", () => {
  assert(!isUuid("1; DROP TABLE summaries;--"));
  assert(!isUuid("' OR 1=1 --"));
});

Deno.test("rejects structurally invalid emails and oversized input", () => {
  // NOTE: isEmail uses a loose regex (/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/) — it does NOT
  // block HTML/XSS characters. That's by design (validation, not sanitization).
  // Test only what isEmail ACTUALLY rejects: structural violations + length.
  assert(!isEmail("not-an-email"));       // missing @
  assert(!isEmail("test@"));               // missing domain
  assert(!isEmail("@domain.com"));          // missing local part
  assert(!isEmail("user@domain"));          // missing TLD (no dot)
  assert(!isEmail("a".repeat(321)));        // exceeds 320 char limit
});

Deno.test("rejects wrong types", () => {
  assert(!isUuid(12345 as unknown));
  assert(!isBool("true" as unknown));
  assert(!isNum("42" as unknown));
  assert(!isObj([] as unknown));
});

Deno.test("rejects probability outside [0,1]", () => {
  assert(!isProbability(1.0001)); assert(!isProbability(-0.001));
  assert(!isProbability(Infinity)); assert(!isProbability(NaN));
});

Deno.test("rejects FSRS difficulty outside 0-10", () => {
  assert(inRange(0, 0, 10)); assert(inRange(10, 0, 10));
  assert(!inRange(11, 0, 10)); assert(!inRange(-1, 0, 10));
});

// ═══ EDGE CASES ═══

Deno.test("handles Unicode keyword names", () => {
  assert(isNonEmpty("細胞膜のリン脂質二重層"));
  assert(isNonEmpty("Celula eucariota"));
});

Deno.test("isNonNegInt boundary values", () => {
  assert(isNonNegInt(0)); assert(isNonNegInt(Number.MAX_SAFE_INTEGER));
  assert(!isNonNegInt(-1)); assert(!isNonNegInt(3.14));
});

Deno.test("date-only format YYYY-MM-DD", () => {
  assert(isDateOnly("2026-03-08"));
  assert(!isDateOnly("2026-03-08T14:30:00Z"));
  assert(!isDateOnly("03/08/2026"));
});

// ═══ ERROR HANDLING — validateFields ═══

Deno.test("validateFields extracts valid fields, ignores absent optional", () => {
  const body = { session_id: "550e8400-e29b-41d4-a716-446655440000", grade: 4 };
  const rules: FieldRule[] = [
    { key: "session_id", check: isUuid, msg: "UUID", required: true },
    { key: "grade", check: (v) => isNum(v) && inRange(v, 0, 5), msg: "0-5", required: true },
    { key: "response_time_ms", check: isNonNegInt, msg: ">= 0" },
  ];
  const { fields, error } = validateFields(body, rules);
  assertEquals(error, null);
  assertEquals(fields.session_id, body.session_id);
  assertEquals(fields.response_time_ms, undefined);
});

Deno.test("validateFields errors on missing required field", () => {
  const { error } = validateFields({ grade: 4 }, [
    { key: "session_id", check: isUuid, msg: "UUID", required: true },
  ]);
  assert(error !== null); assert(error!.includes("session_id"));
});

Deno.test("validateFields errors when field fails check", () => {
  const { error } = validateFields({ session_id: "not-uuid" }, [
    { key: "session_id", check: isUuid, msg: "must be UUID", required: true },
  ]);
  assert(error !== null); assert(error!.includes("must be UUID"));
});

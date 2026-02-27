import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isUuid,
  isEmail,
  isIsoTs,
  isDateOnly,
  isNonEmpty,
  isNonNeg,
  isNonNegInt,
  isProbability,
  inRange,
  isOneOf,
  isBool,
  isNum,
  isObj,
  validateFields,
} from "../validate.ts";

// ── UUID ──────────────────────────────────────────────────────────
Deno.test("isUuid: valid v4", () =>
  assertEquals(isUuid("550e8400-e29b-41d4-a716-446655440000"), true));
Deno.test("isUuid: invalid", () => assertEquals(isUuid("not-a-uuid"), false));
Deno.test("isUuid: null", () => assertEquals(isUuid(null), false));
Deno.test("isUuid: number", () => assertEquals(isUuid(42), false));

// ── Email ─────────────────────────────────────────────────────────
Deno.test("isEmail: valid", () =>
  assertEquals(isEmail("test@example.com"), true));
Deno.test("isEmail: no @", () => assertEquals(isEmail("not-email"), false));

// ── ISO Timestamp ─────────────────────────────────────────────────
Deno.test("isIsoTs: valid", () =>
  assertEquals(isIsoTs("2026-02-27T12:00:00Z"), true));
Deno.test("isIsoTs: invalid", () => assertEquals(isIsoTs("nope"), false));

// ── Date Only ─────────────────────────────────────────────────────
Deno.test("isDateOnly: valid", () =>
  assertEquals(isDateOnly("2026-02-27"), true));
Deno.test("isDateOnly: with time", () =>
  assertEquals(isDateOnly("2026-02-27T12:00:00Z"), false));

// ── Non-empty ─────────────────────────────────────────────────────
Deno.test("isNonEmpty: hello", () => assertEquals(isNonEmpty("hello"), true));
Deno.test("isNonEmpty: empty", () => assertEquals(isNonEmpty(""), false));
Deno.test("isNonEmpty: whitespace", () =>
  assertEquals(isNonEmpty("   "), false));

// ── Numeric ───────────────────────────────────────────────────────
Deno.test("isNonNeg: 0", () => assertEquals(isNonNeg(0), true));
Deno.test("isNonNeg: -1", () => assertEquals(isNonNeg(-1), false));
Deno.test("isNonNeg: NaN", () => assertEquals(isNonNeg(NaN), false));
Deno.test("isNonNegInt: 5", () => assertEquals(isNonNegInt(5), true));
Deno.test("isNonNegInt: 1.5", () => assertEquals(isNonNegInt(1.5), false));
Deno.test("isProbability: 0.5", () => assertEquals(isProbability(0.5), true));
Deno.test("isProbability: 1.1", () => assertEquals(isProbability(1.1), false));
Deno.test("inRange: 3 in [0,5]", () => assertEquals(inRange(3, 0, 5), true));
Deno.test("inRange: 6 in [0,5]", () => assertEquals(inRange(6, 0, 5), false));

// ── Type guards ───────────────────────────────────────────────────
Deno.test("isBool: true", () => assertEquals(isBool(true), true));
Deno.test("isBool: string", () => assertEquals(isBool("true"), false));
Deno.test("isNum: 42", () => assertEquals(isNum(42), true));
Deno.test("isNum: Infinity", () => assertEquals(isNum(Infinity), false));
Deno.test("isObj: object", () => assertEquals(isObj({ a: 1 }), true));
Deno.test("isObj: array", () => assertEquals(isObj([1, 2]), false));
Deno.test("isObj: null", () => assertEquals(isObj(null), false));

// ── isOneOf ───────────────────────────────────────────────────────
Deno.test("isOneOf: valid", () =>
  assertEquals(isOneOf("new", ["new", "review"] as const), true));
Deno.test("isOneOf: invalid", () =>
  assertEquals(isOneOf("other", ["new", "review"] as const), false));

// ── validateFields ────────────────────────────────────────────────
Deno.test("validateFields: picks valid optional fields", () => {
  const { fields, error } = validateFields(
    { name: "test", age: 25 },
    [
      { key: "name", check: (v) => isNonEmpty(v), msg: "required" },
      { key: "age", check: (v) => isNonNegInt(v), msg: "must be int" },
    ],
  );
  assertEquals(error, null);
  assertEquals(fields, { name: "test", age: 25 });
});

Deno.test("validateFields: returns error for invalid field", () => {
  const { error } = validateFields(
    { name: "" },
    [{ key: "name", check: (v) => isNonEmpty(v), msg: "must be non-empty" }],
  );
  assertEquals(error, "name: must be non-empty");
});

Deno.test("validateFields: skips missing optional fields", () => {
  const { fields, error } = validateFields(
    {},
    [{ key: "opt", check: (v) => isNonEmpty(v), msg: "err" }],
  );
  assertEquals(error, null);
  assertEquals(fields, {});
});

Deno.test("validateFields: enforces required fields", () => {
  const { error } = validateFields(
    {},
    [
      {
        key: "req",
        check: (v) => isNonEmpty(v),
        msg: "err",
        required: true,
      },
    ],
  );
  assertEquals(error, "Missing required field: req");
});

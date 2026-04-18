/**
 * Tests for routes/_messaging/linking-code.ts
 *
 * Covers the 10-digit linking code primitives used by Telegram and WhatsApp
 * linking flows after the SEC-AUDIT entropy bump.
 *
 * Run: deno test supabase/functions/server/tests/linking_code_test.ts
 */

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CODE_LENGTH,
  generateLinkingCode,
  isLinkingCode,
} from "../routes/_messaging/linking-code.ts";

// ─── generateLinkingCode ──────────────────────────────────────────

Deno.test("generateLinkingCode: always returns exactly CODE_LENGTH characters", () => {
  for (let i = 0; i < 1000; i++) {
    const code = generateLinkingCode();
    assertEquals(code.length, CODE_LENGTH);
  }
});

Deno.test("generateLinkingCode: only decimal digits", () => {
  for (let i = 0; i < 1000; i++) {
    const code = generateLinkingCode();
    assert(/^\d+$/.test(code), `code "${code}" contains non-digit characters`);
  }
});

Deno.test("generateLinkingCode: zero-pads small values", () => {
  // Generate many codes; statistically some should start with 0 (uniform distribution).
  // With 10-digit codes, ~10% of codes begin with '0'. In 1000 iterations we expect ~100.
  let leadingZeros = 0;
  for (let i = 0; i < 1000; i++) {
    if (generateLinkingCode().startsWith("0")) leadingZeros++;
  }
  // Very loose bound — just confirms padStart is active (not returning numbers as-is).
  assert(leadingZeros > 20, `expected some leading-zero codes, got ${leadingZeros}`);
});

Deno.test("generateLinkingCode: collision rate is negligible", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 10_000; i++) {
    seen.add(generateLinkingCode());
  }
  // With 10^10 space and 10_000 draws, birthday-paradox collisions ≈ 10_000^2 / (2*10^10)
  // ≈ 0.005. In practice we expect zero collisions per run.
  assert(seen.size >= 9998, `collision rate too high: only ${seen.size} unique of 10000`);
});

// ─── isLinkingCode ────────────────────────────────────────────────

Deno.test("isLinkingCode: accepts exactly CODE_LENGTH digits", () => {
  assertEquals(isLinkingCode("0123456789"), true);
  assertEquals(isLinkingCode("9876543210"), true);
  assertEquals(isLinkingCode("0000000000"), true);
});

Deno.test("isLinkingCode: rejects legacy 6-digit codes", () => {
  assertEquals(isLinkingCode("123456"), false);
  assertEquals(isLinkingCode("000000"), false);
});

Deno.test("isLinkingCode: rejects codes with wrong length", () => {
  assertEquals(isLinkingCode("123"), false);
  assertEquals(isLinkingCode("12345678901"), false);
  assertEquals(isLinkingCode(""), false);
});

Deno.test("isLinkingCode: rejects non-digit characters", () => {
  assertEquals(isLinkingCode("1234567890a"), false);
  assertEquals(isLinkingCode("abcdefghij"), false);
  assertEquals(isLinkingCode("1234-56789"), false);
});

Deno.test("isLinkingCode: trims surrounding whitespace", () => {
  assertEquals(isLinkingCode(" 1234567890 "), true);
  assertEquals(isLinkingCode("\n1234567890\n"), true);
});

Deno.test("isLinkingCode: rejects internal whitespace", () => {
  assertEquals(isLinkingCode("12345 67890"), false);
});

Deno.test("isLinkingCode: rejects generated code when len differs (sanity)", () => {
  // Sanity: every value from generator passes the validator.
  for (let i = 0; i < 100; i++) {
    assertEquals(isLinkingCode(generateLinkingCode()), true);
  }
});

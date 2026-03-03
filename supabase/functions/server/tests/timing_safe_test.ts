import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { timingSafeEqual } from "../timing-safe.ts";

Deno.test("timingSafeEqual: identical strings return true", () => {
  assertEquals(timingSafeEqual("abc123", "abc123"), true);
});

Deno.test("timingSafeEqual: different strings return false", () => {
  assertEquals(timingSafeEqual("abc123", "abc124"), false);
});

Deno.test("timingSafeEqual: different lengths return false immediately", () => {
  assertEquals(timingSafeEqual("abc", "abcd"), false);
});

Deno.test("timingSafeEqual: empty strings return true", () => {
  assertEquals(timingSafeEqual("", ""), true);
});

Deno.test("timingSafeEqual: hex signature comparison (64-char SHA256)", () => {
  const sig =
    "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";
  assertEquals(timingSafeEqual(sig, sig), true);
  assertEquals(timingSafeEqual(sig, sig.replace("a1", "b1")), false);
  // Differ only in last byte
  assertEquals(
    timingSafeEqual(sig, sig.slice(0, -2) + "ff"),
    false,
  );
});

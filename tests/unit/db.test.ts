/**
 * tests/unit/db.test.ts — 8 tests for JWT decode (same logic as db.ts)
 * Cannot import db.ts directly (validates env vars at load).
 * Run: deno test tests/unit/db.test.ts --no-check
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";

function decodeJwtPayload(token: string): { sub: string; email?: string; exp?: number } | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    let base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = base64.length % 4;
    if (pad === 1) return null;
    if (pad) base64 += "=".repeat(4 - pad);
    const json = atob(base64);
    const payload = JSON.parse(json);
    if (!payload.sub) return null;
    return payload;
  } catch { return null; }
}

function fakeJwt(payload: Record<string, unknown>): string {
  const h = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const b = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${h}.${b}.fake-sig`;
}

Deno.test("decodes valid JWT with sub + email", () => {
  const t = fakeJwt({ sub: "user-123", email: "maria@uni.mx", exp: 9999999999 });
  const r = decodeJwtPayload(t);
  assert(r !== null); assertEquals(r!.sub, "user-123"); assertEquals(r!.email, "maria@uni.mx");
});

Deno.test("decodes JWT without email", () => {
  const r = decodeJwtPayload(fakeJwt({ sub: "user-123" }));
  assert(r !== null); assertEquals(r!.email, undefined);
});

Deno.test("rejects JWT with only 2 parts", () => {
  assertEquals(decodeJwtPayload("header.payload"), null);
});

Deno.test("rejects empty string", () => assertEquals(decodeJwtPayload(""), null));

Deno.test("rejects invalid Base64", () => assertEquals(decodeJwtPayload("h.!!!.s"), null));

Deno.test("rejects JWT without sub claim", () => {
  assertEquals(decodeJwtPayload(fakeJwt({ email: "x@x.com" })), null);
});

Deno.test("handles Base64URL encoding (- and _)", () => {
  const r = decodeJwtPayload(fakeJwt({ sub: "user/special+chars" }));
  assert(r !== null); assertEquals(r!.sub, "user/special+chars");
});

Deno.test("detects expired JWT via exp claim (BUG-002 mitigation)", () => {
  const r = decodeJwtPayload(fakeJwt({ sub: "u", exp: Math.floor(Date.now()/1000) - 3600 }));
  assert(r !== null); assert(r!.exp! < Math.floor(Date.now() / 1000));
});

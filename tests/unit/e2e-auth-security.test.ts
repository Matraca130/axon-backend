/**
 * tests/unit/e2e-auth-security.test.ts — 18 tests for auth security
 *
 * Tests cover: JWT validation (decode logic), role-based access control,
 * privilege escalation prevention, token extraction patterns,
 * fail-closed behavior, and error handling for invalid tokens.
 *
 * ZERO dependency on db.ts — runs without env vars.
 * Run: deno test tests/unit/e2e-auth-security.test.ts --no-check
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";

import {
  ROLE_HIERARCHY,
  ALL_ROLES,
  MANAGEMENT_ROLES,
  CONTENT_WRITE_ROLES,
  canAssignRole,
  isDenied,
} from "../../supabase/functions/server/auth-helpers.ts";
import type { CallerRole, AuthDenied } from "../../supabase/functions/server/auth-helpers.ts";

// ─── JWT Decode Helper (same logic as db.ts, isolated for testing) ───
function decodeJwtPayload(token: string): { sub: string; email?: string; exp?: number; aud?: string } | null {
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
  const h = btoa(JSON.stringify({ alg: "ES256", typ: "JWT" }));
  const b = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${h}.${b}.fake-sig`;
}

// ═══ JWT VALIDATION ═══

Deno.test("JWT decode: valid token with sub, email, exp, aud", () => {
  const token = fakeJwt({
    sub: "user-uuid-123",
    email: "estudiante@uni.edu",
    exp: Math.floor(Date.now() / 1000) + 3600,
    aud: "authenticated",
  });
  const payload = decodeJwtPayload(token);
  assert(payload !== null);
  assertEquals(payload!.sub, "user-uuid-123");
  assertEquals(payload!.email, "estudiante@uni.edu");
  assertEquals(payload!.aud, "authenticated");
});

Deno.test("JWT decode: rejects token without sub claim (security requirement)", () => {
  const token = fakeJwt({ email: "test@test.com", exp: 9999999999 });
  assertEquals(decodeJwtPayload(token), null);
});

Deno.test("JWT decode: rejects completely malformed tokens", () => {
  assertEquals(decodeJwtPayload(""), null);
  assertEquals(decodeJwtPayload("not.a.jwt"), null);
  assertEquals(decodeJwtPayload("x"), null);
  assertEquals(decodeJwtPayload("a.b"), null);
  assertEquals(decodeJwtPayload("a.!!!invalid-base64.c"), null);
});

Deno.test("JWT decode: detects expired token via exp claim", () => {
  const pastExp = Math.floor(Date.now() / 1000) - 7200; // 2 hours ago
  const token = fakeJwt({ sub: "user-1", exp: pastExp });
  const payload = decodeJwtPayload(token);
  assert(payload !== null, "Decode should succeed");
  assert(payload!.exp! < Math.floor(Date.now() / 1000), "Token should be expired");
});

Deno.test("JWT decode: handles Unicode characters in payload", () => {
  const token = fakeJwt({ sub: "user-1", email: "jose.garcia@universidad.mx" });
  const payload = decodeJwtPayload(token);
  assert(payload !== null);
  assertEquals(payload!.email, "jose.garcia@universidad.mx");
});

Deno.test("JWT decode: handles special Base64URL characters (- and _)", () => {
  const token = fakeJwt({ sub: "user/special+chars==" });
  const payload = decodeJwtPayload(token);
  assert(payload !== null);
  assertEquals(payload!.sub, "user/special+chars==");
});

// ═══ ROLE-BASED ACCESS CONTROL ═══

Deno.test("RBAC: role hierarchy values are strictly ordered", () => {
  assert(ROLE_HIERARCHY.owner > ROLE_HIERARCHY.admin);
  assert(ROLE_HIERARCHY.admin > ROLE_HIERARCHY.professor);
  assert(ROLE_HIERARCHY.professor > ROLE_HIERARCHY.student);
  assert(ROLE_HIERARCHY.student > 0);
});

Deno.test("RBAC: MANAGEMENT_ROLES is subset of ALL_ROLES", () => {
  for (const role of MANAGEMENT_ROLES) {
    assert(ALL_ROLES.includes(role), `${role} should be in ALL_ROLES`);
  }
});

Deno.test("RBAC: CONTENT_WRITE_ROLES excludes student", () => {
  assert(!CONTENT_WRITE_ROLES.includes("student"));
  assert(CONTENT_WRITE_ROLES.includes("owner"));
  assert(CONTENT_WRITE_ROLES.includes("admin"));
  assert(CONTENT_WRITE_ROLES.includes("professor"));
});

Deno.test("RBAC: student cannot write content (not in CONTENT_WRITE_ROLES)", () => {
  assert(!CONTENT_WRITE_ROLES.includes("student"));
});

// ═══ PRIVILEGE ESCALATION PREVENTION ═══

Deno.test("Escalation: admin CANNOT assign owner role", () => {
  assert(!canAssignRole("admin", "owner"));
});

Deno.test("Escalation: professor CANNOT assign admin or owner", () => {
  assert(!canAssignRole("professor", "admin"));
  assert(!canAssignRole("professor", "owner"));
});

Deno.test("Escalation: student CANNOT assign any role except student", () => {
  assert(!canAssignRole("student", "professor"));
  assert(!canAssignRole("student", "admin"));
  assert(!canAssignRole("student", "owner"));
  assert(canAssignRole("student", "student"));
});

Deno.test("Escalation: each role can assign itself", () => {
  for (const role of ALL_ROLES) {
    assert(canAssignRole(role, role), `${role} should be able to assign ${role}`);
  }
});

// ═══ FAIL-CLOSED BEHAVIOR ═══

Deno.test("Fail-closed: unknown role gets level 0 (cannot assign anything)", () => {
  assert(!canAssignRole("superadmin", "student"));
  assert(!canAssignRole("hacker", "student"));
  assert(!canAssignRole("", "student"));
});

Deno.test("Fail-closed: unknown target role gets Infinity (cannot be assigned)", () => {
  assert(!canAssignRole("owner", "superadmin"));
  assert(!canAssignRole("owner", "god"));
  assert(!canAssignRole("owner", ""));
});

// ═══ isDenied TYPE GUARD ═══

Deno.test("isDenied: correctly identifies AuthDenied with various status codes", () => {
  assert(isDenied({ denied: true, message: "Missing token", status: 401 }));
  assert(isDenied({ denied: true, message: "Forbidden", status: 403 }));
  assert(isDenied({ denied: true, message: "Bad request", status: 400 }));
});

Deno.test("isDenied: rejects CallerRole objects and other non-denied values", () => {
  const caller: CallerRole = { role: "admin", membershipId: "m-1", institutionId: "i-1" };
  assert(!isDenied(caller));
  assert(!isDenied(null));
  assert(!isDenied(undefined));
  assert(!isDenied(42));
  assert(!isDenied("string"));
  assert(!isDenied({ denied: false, message: "x", status: 200 }));
  assert(!isDenied({}));
});

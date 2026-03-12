/**
 * tests/unit/auth-helpers.test.ts — 14 tests for auth-helpers.ts
 * ZERO dependency on db.ts — runs without env vars.
 * Run: deno test tests/unit/auth-helpers.test.ts --no-check
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import {
  ROLE_HIERARCHY, ALL_ROLES, MANAGEMENT_ROLES, CONTENT_WRITE_ROLES,
  canAssignRole, isDenied,
} from "../../supabase/functions/server/auth-helpers.ts";
import type { CallerRole, AuthDenied } from "../../supabase/functions/server/auth-helpers.ts";

// ═══ HAPPY PATH ═══

Deno.test("role hierarchy: owner=4 > admin=3 > professor=2 > student=1", () => {
  assertEquals(ROLE_HIERARCHY["owner"], 4);
  assertEquals(ROLE_HIERARCHY["admin"], 3);
  assertEquals(ROLE_HIERARCHY["professor"], 2);
  assertEquals(ROLE_HIERARCHY["student"], 1);
});

Deno.test("ALL_ROLES has exactly 4 valid roles", () => {
  assertEquals(ALL_ROLES.length, 4);
  for (const r of ["owner","admin","professor","student"]) assert(ALL_ROLES.includes(r));
});

Deno.test("MANAGEMENT_ROLES is owner + admin only", () => {
  assertEquals(MANAGEMENT_ROLES.length, 2);
  assert(!MANAGEMENT_ROLES.includes("professor"));
  assert(!MANAGEMENT_ROLES.includes("student"));
});

Deno.test("CONTENT_WRITE_ROLES excludes student", () => {
  assert(CONTENT_WRITE_ROLES.includes("professor"));
  assert(!CONTENT_WRITE_ROLES.includes("student"));
});

// ═══ PRIVILEGE ESCALATION PREVENTION ═══

Deno.test("owner can assign ALL roles", () => {
  for (const r of ALL_ROLES) assert(canAssignRole("owner", r));
});

Deno.test("admin CANNOT assign owner (escalation blocked)", () => {
  assert(canAssignRole("admin", "admin"));
  assert(canAssignRole("admin", "student"));
  assert(!canAssignRole("admin", "owner"));
});

Deno.test("professor can only assign professor + student", () => {
  assert(canAssignRole("professor", "student"));
  assert(!canAssignRole("professor", "admin"));
  assert(!canAssignRole("professor", "owner"));
});

Deno.test("student can only assign student", () => {
  assert(canAssignRole("student", "student"));
  assert(!canAssignRole("student", "professor"));
});

// ═══ EDGE CASES — Unknown roles (fail-closed) ═══

Deno.test("unknown callerRole gets level 0 — can't assign anything", () => {
  assert(!canAssignRole("superadmin", "student"));
  assert(!canAssignRole("", "student"));
});

Deno.test("unknown targetRole gets Infinity — can never be assigned", () => {
  assert(!canAssignRole("owner", "superadmin"));
  assert(!canAssignRole("owner", ""));
});

// ═══ isDenied type guard ═══

Deno.test("isDenied identifies AuthDenied objects", () => {
  const denied: AuthDenied = { denied: true, message: "No access", status: 403 };
  assert(isDenied(denied));
});

Deno.test("isDenied identifies CallerRole as NOT denied", () => {
  const caller: CallerRole = { role: "admin", membershipId: "uuid-1", institutionId: "uuid-2" };
  assert(!isDenied(caller));
});

Deno.test("isDenied handles null, undefined, primitives safely", () => {
  assert(!isDenied(null)); assert(!isDenied(undefined));
  assert(!isDenied("string")); assert(!isDenied(42));
});

Deno.test("isDenied rejects { denied: false }", () => {
  assert(!isDenied({ denied: false, message: "x", status: 200 }));
});

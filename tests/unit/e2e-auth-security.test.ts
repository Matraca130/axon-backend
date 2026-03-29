/**
 * tests/unit/e2e-auth-security.test.ts \xe2\x80\x94 12 tests for auth security
 *
 * Tests cover: role-based access control, privilege escalation prevention,
 * fail-closed behavior, and isDenied type guard.
 *
 * ZERO dependency on db.ts \xe2\x80\x94 runs without env vars.
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

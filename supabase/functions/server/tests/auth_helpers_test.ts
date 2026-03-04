/**
 * Tests for auth-helpers.ts — Institution authorization helpers.
 *
 * Tests cover:
 *   1. ROLE_HIERARCHY structure and completeness
 *   2. canAssignRole() exhaustive matrix + edge cases
 *   3. isDenied() type guard
 *   4. resolveCallerRole() with mock Supabase client
 *   5. requireInstitutionRole() with mock Supabase client
 *   6. resolveMembershipInstitution() with mock Supabase client
 *
 * No real Supabase connection needed — all DB calls use a fluent mock.
 *
 * Run: deno test supabase/functions/server/tests/auth_helpers_test.ts
 */

import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  canAssignRole,
  isDenied,
  resolveCallerRole,
  requireInstitutionRole,
  resolveMembershipInstitution,
  ROLE_HIERARCHY,
  ALL_ROLES,
  MANAGEMENT_ROLES,
  CONTENT_WRITE_ROLES,
  type CallerRole,
  type AuthDenied,
} from "../auth-helpers.ts";

// ═════════════════════════════════════════════════════════════════════
// Mock Supabase Client Factory
// ═════════════════════════════════════════════════════════════════════

/**
 * Creates a mock Supabase client with a fluent API that returns
 * the specified data/error when .single() is called.
 *
 * All chainable methods (from, select, eq, limit, etc.) return `this`,
 * so the call chain works regardless of how many filters are applied.
 */
function mockDb(opts: { data?: unknown; error?: unknown }): any {
  const { data = null, error = null } = opts;
  const chain: Record<string, unknown> = {};
  const chainMethods = [
    "from", "select", "eq", "neq", "gt", "lt", "gte", "lte",
    "like", "ilike", "is", "in", "not", "or", "and",
    "order", "limit", "range", "filter",
  ];
  for (const method of chainMethods) {
    chain[method] = () => chain;
  }
  chain.single = () => Promise.resolve({ data, error });
  return chain;
}

/** Mock DB that throws on .single() — simulates network failure. */
function mockDbThrowing(): any {
  const chain: Record<string, unknown> = {};
  const chainMethods = [
    "from", "select", "eq", "neq", "gt", "lt", "gte", "lte",
    "like", "ilike", "is", "in", "not", "or", "and",
    "order", "limit", "range", "filter",
  ];
  for (const method of chainMethods) {
    chain[method] = () => chain;
  }
  chain.single = () => { throw new Error("Network timeout"); };
  return chain;
}

// ═════════════════════════════════════════════════════════════════════
// 1. ROLE_HIERARCHY
// ═════════════════════════════════════════════════════════════════════

Deno.test("ROLE_HIERARCHY: contains all 4 standard roles", () => {
  assertEquals(Object.keys(ROLE_HIERARCHY).sort(), [
    "admin", "owner", "professor", "student",
  ]);
});

Deno.test("ROLE_HIERARCHY: owner > admin > professor > student", () => {
  assertEquals(ROLE_HIERARCHY.owner > ROLE_HIERARCHY.admin, true);
  assertEquals(ROLE_HIERARCHY.admin > ROLE_HIERARCHY.professor, true);
  assertEquals(ROLE_HIERARCHY.professor > ROLE_HIERARCHY.student, true);
});

Deno.test("ALL_ROLES contains all hierarchy keys", () => {
  assertEquals(ALL_ROLES.sort(), Object.keys(ROLE_HIERARCHY).sort());
});

Deno.test("MANAGEMENT_ROLES is owner + admin only", () => {
  assertEquals(MANAGEMENT_ROLES.sort(), ["admin", "owner"]);
});

Deno.test("CONTENT_WRITE_ROLES is owner + admin + professor", () => {
  assertEquals(CONTENT_WRITE_ROLES.sort(), ["admin", "owner", "professor"]);
});

// ═════════════════════════════════════════════════════════════════════
// 2. canAssignRole — exhaustive matrix
// ═════════════════════════════════════════════════════════════════════

Deno.test("canAssignRole: owner can assign all roles", () => {
  assertEquals(canAssignRole("owner", "owner"), true);
  assertEquals(canAssignRole("owner", "admin"), true);
  assertEquals(canAssignRole("owner", "professor"), true);
  assertEquals(canAssignRole("owner", "student"), true);
});

Deno.test("canAssignRole: admin can assign admin/professor/student but NOT owner", () => {
  assertEquals(canAssignRole("admin", "owner"), false);
  assertEquals(canAssignRole("admin", "admin"), true);
  assertEquals(canAssignRole("admin", "professor"), true);
  assertEquals(canAssignRole("admin", "student"), true);
});

Deno.test("canAssignRole: professor can assign professor/student but NOT admin/owner", () => {
  assertEquals(canAssignRole("professor", "owner"), false);
  assertEquals(canAssignRole("professor", "admin"), false);
  assertEquals(canAssignRole("professor", "professor"), true);
  assertEquals(canAssignRole("professor", "student"), true);
});

Deno.test("canAssignRole: student can only assign student", () => {
  assertEquals(canAssignRole("student", "owner"), false);
  assertEquals(canAssignRole("student", "admin"), false);
  assertEquals(canAssignRole("student", "professor"), false);
  assertEquals(canAssignRole("student", "student"), true);
});

Deno.test("canAssignRole: unknown caller role → false (fail-closed)", () => {
  assertEquals(canAssignRole("hacker", "student"), false);
  assertEquals(canAssignRole("", "student"), false);
});

Deno.test("canAssignRole: unknown target role → false (fail-closed)", () => {
  assertEquals(canAssignRole("owner", "superadmin"), false);
  assertEquals(canAssignRole("owner", ""), false);
});

Deno.test("canAssignRole: both unknown → false (fail-closed)", () => {
  assertEquals(canAssignRole("foo", "bar"), false);
});

// ═════════════════════════════════════════════════════════════════════
// 3. isDenied type guard
// ═════════════════════════════════════════════════════════════════════

Deno.test("isDenied: returns true for AuthDenied objects", () => {
  const denied: AuthDenied = { denied: true, message: "No access", status: 403 };
  assertEquals(isDenied(denied), true);
});

Deno.test("isDenied: returns false for CallerRole objects", () => {
  const caller: CallerRole = {
    role: "owner",
    membershipId: "mem-123",
    institutionId: "inst-456",
  };
  assertEquals(isDenied(caller), false);
});

Deno.test("isDenied: returns false for null/undefined/primitives", () => {
  assertEquals(isDenied(null as any), false);
  assertEquals(isDenied(undefined as any), false);
  assertEquals(isDenied("string" as any), false);
  assertEquals(isDenied(42 as any), false);
});

Deno.test("isDenied: returns false for objects with denied=false", () => {
  assertEquals(isDenied({ denied: false, message: "x", status: 403 } as any), false);
});

// ═════════════════════════════════════════════════════════════════════
// 4. resolveCallerRole with mock DB
// ═════════════════════════════════════════════════════════════════════

Deno.test("resolveCallerRole: returns CallerRole on success", async () => {
  const db = mockDb({
    data: { id: "mem-abc", role: "admin" },
  });

  const result = await resolveCallerRole(db, "user-123", "inst-456");
  assertExists(result);
  assertEquals(result!.role, "admin");
  assertEquals(result!.membershipId, "mem-abc");
  assertEquals(result!.institutionId, "inst-456");
});

Deno.test("resolveCallerRole: returns null on DB error", async () => {
  const db = mockDb({
    error: { message: "relation not found" },
  });

  const result = await resolveCallerRole(db, "user-123", "inst-456");
  assertEquals(result, null);
});

Deno.test("resolveCallerRole: returns null on empty userId", async () => {
  const db = mockDb({ data: { id: "mem-abc", role: "admin" } });
  assertEquals(await resolveCallerRole(db, "", "inst-456"), null);
});

Deno.test("resolveCallerRole: returns null on empty institutionId", async () => {
  const db = mockDb({ data: { id: "mem-abc", role: "admin" } });
  assertEquals(await resolveCallerRole(db, "user-123", ""), null);
});

Deno.test("resolveCallerRole: returns null when no rows found (data=null)", async () => {
  const db = mockDb({ data: null });
  assertEquals(await resolveCallerRole(db, "user-123", "inst-456"), null);
});

Deno.test("resolveCallerRole: returns null on network failure (fail-closed)", async () => {
  const db = mockDbThrowing();
  assertEquals(await resolveCallerRole(db, "user-123", "inst-456"), null);
});

// ═════════════════════════════════════════════════════════════════════
// 5. requireInstitutionRole with mock DB
// ═════════════════════════════════════════════════════════════════════

Deno.test("requireInstitutionRole: returns CallerRole when role is allowed", async () => {
  const db = mockDb({ data: { id: "mem-abc", role: "owner" } });

  const result = await requireInstitutionRole(db, "user-123", "inst-456", ["owner", "admin"]);
  assertEquals(isDenied(result), false);
  assertEquals((result as CallerRole).role, "owner");
  assertEquals((result as CallerRole).membershipId, "mem-abc");
});

Deno.test("requireInstitutionRole: returns AuthDenied when role not in allowedRoles", async () => {
  const db = mockDb({ data: { id: "mem-abc", role: "student" } });

  const result = await requireInstitutionRole(db, "user-123", "inst-456", ["owner", "admin"]);
  assertEquals(isDenied(result), true);
  assertEquals((result as AuthDenied).status, 403);
  assertEquals(
    (result as AuthDenied).message.includes("Insufficient permissions"),
    true,
  );
});

Deno.test("requireInstitutionRole: returns AuthDenied when no membership exists", async () => {
  const db = mockDb({ data: null });

  const result = await requireInstitutionRole(db, "user-123", "inst-456", ["owner"]);
  assertEquals(isDenied(result), true);
  assertEquals((result as AuthDenied).status, 403);
  assertEquals(
    (result as AuthDenied).message.includes("No active membership"),
    true,
  );
});

Deno.test("requireInstitutionRole: returns AuthDenied (400) on empty institutionId", async () => {
  const db = mockDb({ data: { id: "mem-abc", role: "owner" } });

  const result = await requireInstitutionRole(db, "user-123", "", ["owner"]);
  assertEquals(isDenied(result), true);
  assertEquals((result as AuthDenied).status, 400);
});

Deno.test("requireInstitutionRole: returns AuthDenied on DB error (fail-closed)", async () => {
  const db = mockDb({ error: { message: "timeout" } });

  const result = await requireInstitutionRole(db, "user-123", "inst-456", ["owner"]);
  assertEquals(isDenied(result), true);
  assertEquals((result as AuthDenied).status, 403);
});

// ═════════════════════════════════════════════════════════════════════
// 6. resolveMembershipInstitution with mock DB
// ═════════════════════════════════════════════════════════════════════

Deno.test("resolveMembershipInstitution: returns institution_id on success", async () => {
  const db = mockDb({ data: { institution_id: "inst-789" } });

  const result = await resolveMembershipInstitution(db, "mem-abc");
  assertEquals(result, "inst-789");
});

Deno.test("resolveMembershipInstitution: returns null on not found", async () => {
  const db = mockDb({ data: null });
  assertEquals(await resolveMembershipInstitution(db, "nonexistent"), null);
});

Deno.test("resolveMembershipInstitution: returns null on empty input", async () => {
  const db = mockDb({ data: { institution_id: "inst-789" } });
  assertEquals(await resolveMembershipInstitution(db, ""), null);
});

Deno.test("resolveMembershipInstitution: returns null on DB error (fail-closed)", async () => {
  const db = mockDb({ error: { message: "connection refused" } });
  assertEquals(await resolveMembershipInstitution(db, "mem-abc"), null);
});

Deno.test("resolveMembershipInstitution: returns null on network failure (fail-closed)", async () => {
  const db = mockDbThrowing();
  assertEquals(await resolveMembershipInstitution(db, "mem-abc"), null);
});

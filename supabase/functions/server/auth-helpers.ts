/**
 * auth-helpers.ts — Shared institution authorization helpers for Axon v4.4
 *
 * Provides institution-scoped role checking for routes that need to verify
 * the caller's authority before performing operations.
 *
 * DESIGN DECISIONS:
 *
 *   1. ZERO dependency on db.ts
 *      db.ts validates env vars at module load, which breaks unit tests.
 *      This module only imports the SupabaseClient TYPE from the npm package.
 *      All functions are importable in test environments without side effects.
 *
 *   2. Returns AuthDenied descriptors, NOT Hono Response objects
 *      authenticate() in db.ts returns Response because it's tightly coupled
 *      to Hono (reads headers). Our helpers are pure business logic
 *      (lookup membership, check role), so they return data descriptors.
 *
 *      Caller pattern:
 *        const check = await requireInstitutionRole(db, user.id, instId, ["owner"]);
 *        if (isDenied(check)) return err(c, check.message, check.status);
 *        const { role, membershipId } = check; // narrowed to CallerRole
 *
 *   3. Fail-closed everywhere
 *      - Empty/null inputs → null or deny
 *      - DB error → null or deny
 *      - Unknown role string → canAssignRole returns false
 *      - No membership found → deny
 *      An attacker CANNOT exploit a missing check or null result.
 *
 *   4. User-scoped DB client for all lookups
 *      resolveCallerRole queries the caller's OWN membership → always readable.
 *      resolveMembershipInstitution queries any membership's institution_id →
 *      works with current RLS state, and with future strict policies
 *      (members can see other members in the same institution).
 *
 * SECURITY MODEL:
 *   If any lookup fails (DB error, missing data, RLS denial), access is DENIED.
 *   This prevents fail-open bugs where a null/error result grants access.
 *
 * USED BY: H-1 (admin-scopes), H-2 (institutions), H-3 (memberships),
 *          H-4 (search scoping), H-5 (content crud scoping)
 *
 * Run tests: deno test supabase/functions/server/tests/auth_helpers_test.ts
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js";

// ─── Role Hierarchy ─────────────────────────────────────────────────
// Higher number = more authority.
// Used by canAssignRole() to prevent privilege escalation (H-3).
//
// Invariants:
//   - owner > admin > professor > student
//   - Unknown roles map to 0 (callerLevel) or Infinity (targetLevel)
//     → unknown callers can't assign anything, unknown targets can't be assigned

export const ROLE_HIERARCHY: Record<string, number> = {
  owner: 4,
  admin: 3,
  professor: 2,
  student: 1,
};

// ─── Role Sets ──────────────────────────────────────────────────────
// Pre-defined role arrays for common authorization patterns.
// Using these instead of inline arrays avoids typos and makes grep easier.

/** All valid roles. Use for "any member can access" checks. */
export const ALL_ROLES = Object.keys(ROLE_HIERARCHY);

/** Roles that can manage institution settings, members, scopes. */
export const MANAGEMENT_ROLES = ["owner", "admin"];

/** Roles that can create/edit/delete content (summaries, keywords, etc.). */
export const CONTENT_WRITE_ROLES = ["owner", "admin", "professor"];

// ─── Types ──────────────────────────────────────────────────────────

/** Successful role resolution — contains the caller's role + membership info. */
export interface CallerRole {
  /** The caller's role in the institution (e.g. "owner", "admin"). */
  role: string;
  /** The caller's membership UUID — useful for audit logging. */
  membershipId: string;
  /** The institution UUID — carried through for downstream checks. */
  institutionId: string;
}

/**
 * Authorization denial descriptor — returned instead of throwing or
 * creating Hono Response objects, so this module stays framework-agnostic.
 *
 * Callers convert to Hono response:
 *   if (isDenied(check)) return err(c, check.message, check.status);
 */
export interface AuthDenied {
  /** Discriminant field for type narrowing. Always true. */
  denied: true;
  /** Human-readable error message (safe to return to client). */
  message: string;
  /** HTTP status code (400, 403, 404). */
  status: number;
}

// ─── Type Guard ─────────────────────────────────────────────────────

/**
 * Type guard: narrows CallerRole | AuthDenied to AuthDenied.
 *
 * Works with any union type <T | AuthDenied> thanks to the generic.
 * After the check, TypeScript narrows the other branch to T.
 *
 * Example:
 *   const check = await requireInstitutionRole(db, uid, iid, ["owner"]);
 *   if (isDenied(check)) return err(c, check.message, check.status);
 *   // check is now CallerRole
 *   console.log(check.role, check.membershipId);
 */
export function isDenied<T>(value: T | AuthDenied): value is AuthDenied {
  return (
    typeof value === "object" &&
    value !== null &&
    "denied" in value &&
    (value as AuthDenied).denied === true
  );
}

// ─── Internal Helper ────────────────────────────────────────────────

/** Create an AuthDenied descriptor. Internal — not exported. */
function deny(message: string, status: number = 403): AuthDenied {
  return { denied: true, message, status };
}

// ─── Core Functions ─────────────────────────────────────────────────

/**
 * Look up the caller's active membership in a specific institution.
 *
 * Returns the caller's role + membership ID, or null if:
 *   - The user has no active membership in this institution
 *   - The DB query fails (network error, RLS denial)
 *   - Inputs are empty/invalid
 *
 * This is the low-level building block. Most routes should use
 * requireInstitutionRole() instead, which adds role validation.
 *
 * Query: memberships WHERE user_id AND institution_id AND is_active = true
 * Cost: 1 indexed query, ~3-5ms
 *
 * @param db - User-scoped Supabase client (from authenticate())
 * @param userId - The authenticated caller's UUID (user.id)
 * @param institutionId - The target institution UUID
 */
export async function resolveCallerRole(
  db: SupabaseClient,
  userId: string,
  institutionId: string,
): Promise<CallerRole | null> {
  // Fail-closed: empty inputs → no membership → denied upstream
  if (!userId || !institutionId) return null;

  try {
    const { data, error } = await db
      .from("memberships")
      .select("id, role")
      .eq("user_id", userId)
      .eq("institution_id", institutionId)
      .eq("is_active", true)
      .limit(1)
      .single();

    if (error || !data) return null;

    return {
      role: data.role as string,
      membershipId: data.id as string,
      institutionId,
    };
  } catch {
    // Unexpected error (e.g. network timeout) → fail-closed
    return null;
  }
}

/**
 * Verify the caller has an allowed role in the specified institution.
 *
 * Returns CallerRole on success, or AuthDenied on failure.
 * This is the PRIMARY authorization check used by route handlers.
 *
 * Failure modes (all fail-closed):
 *   - Missing/invalid institutionId → AuthDenied (400)
 *   - No active membership → AuthDenied (403)
 *   - Role not in allowedRoles → AuthDenied (403)
 *   - DB error → AuthDenied (403) via resolveCallerRole returning null
 *
 * Usage:
 *   const check = await requireInstitutionRole(db, user.id, instId, ["owner", "admin"]);
 *   if (isDenied(check)) return err(c, check.message, check.status);
 *   // check.role is guaranteed to be "owner" or "admin" here
 *
 * @param db - User-scoped Supabase client
 * @param userId - The authenticated caller's UUID
 * @param institutionId - The target institution UUID
 * @param allowedRoles - Array of roles that are authorized (e.g. ["owner", "admin"])
 */
export async function requireInstitutionRole(
  db: SupabaseClient,
  userId: string,
  institutionId: string,
  allowedRoles: string[],
): Promise<CallerRole | AuthDenied> {
  // Validate institutionId before wasting a DB query
  if (!institutionId || typeof institutionId !== "string") {
    return deny("Institution ID is required for authorization", 400);
  }

  const caller = await resolveCallerRole(db, userId, institutionId);

  if (!caller) {
    // Intentionally vague: don't reveal whether the institution exists
    // or the user simply isn't a member. Both return 403.
    return deny("No active membership in this institution", 403);
  }

  if (!allowedRoles.includes(caller.role)) {
    return deny(
      `Insufficient permissions. Required role: ${allowedRoles.join(" or ")}`,
      403,
    );
  }

  return caller;
}

/**
 * Given a membership ID, resolve which institution it belongs to.
 *
 * Used by H-1 (admin-scopes) where the route receives a membership_id
 * and needs to determine the institution for authorization.
 *
 * Chain: membership_id → memberships.institution_id → requireInstitutionRole()
 *
 * Returns null if the membership doesn't exist, is inaccessible, or
 * the input is invalid. Callers should return 404 on null.
 *
 * @param db - User-scoped Supabase client
 * @param membershipId - The target membership UUID to look up
 */
export async function resolveMembershipInstitution(
  db: SupabaseClient,
  membershipId: string,
): Promise<string | null> {
  if (!membershipId || typeof membershipId !== "string") return null;

  try {
    const { data, error } = await db
      .from("memberships")
      .select("institution_id")
      .eq("id", membershipId)
      .limit(1)
      .single();

    if (error || !data) return null;
    return data.institution_id as string;
  } catch {
    return null;
  }
}

/**
 * Check if a caller's role is high enough to assign a target role.
 *
 * Used by H-3 (memberships POST) to prevent privilege escalation:
 *   - Owner (4) can assign: owner, admin, professor, student
 *   - Admin (3) can assign: admin, professor, student (NOT owner)
 *   - Professor (2) can assign: professor, student
 *   - Student (1) can assign: student only
 *
 * In practice, only owners and admins reach this check (filtered by
 * requireInstitutionRole with MANAGEMENT_ROLES first).
 *
 * Edge cases (all fail-closed):
 *   - Unknown callerRole → level 0 → can't assign anything
 *   - Unknown targetRole → level Infinity → can't be assigned
 *   - Empty strings → level 0/Infinity → can't assign/be assigned
 *
 * @param callerRole - The authenticated caller's role string
 * @param targetRole - The role being assigned to the new member
 */
export function canAssignRole(
  callerRole: string,
  targetRole: string,
): boolean {
  const callerLevel = ROLE_HIERARCHY[callerRole] ?? 0;
  const targetLevel = ROLE_HIERARCHY[targetRole] ?? Infinity;
  return callerLevel >= targetLevel;
}

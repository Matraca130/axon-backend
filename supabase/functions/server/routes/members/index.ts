/**
 * routes/members/index.ts — Members module combiner
 *
 * Mounts all member sub-modules into a single Hono router.
 * Replaces the old monolithic routes-members.tsx (17KB).
 *
 * Sub-modules:
 *   institutions.ts  — Institution CRUD (5 endpoints)
 *   memberships.ts   — Membership CRUD (5 endpoints)
 *   admin-scopes.ts  — Admin scope management (3 endpoints)
 */

import { Hono } from "npm:hono";
import { institutionRoutes } from "./institutions.ts";
import { membershipRoutes } from "./memberships.ts";
import { adminScopeRoutes } from "./admin-scopes.ts";

const memberRoutes = new Hono();

memberRoutes.route("/", institutionRoutes);
memberRoutes.route("/", membershipRoutes);
memberRoutes.route("/", adminScopeRoutes);

export { memberRoutes };

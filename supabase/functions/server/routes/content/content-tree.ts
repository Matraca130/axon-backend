/**
 * routes/content/content-tree.ts — Nested content hierarchy endpoint
 *
 * GET /content-tree?institution_id=xxx
 * Returns: courses -> semesters -> sections -> topics (lightweight, no summaries)
 *
 * H-5 FIX: Now verifies caller is a member of the requested institution.
 */

import { Hono } from "npm:hono";
import { authenticate, ok, err, PREFIX } from "../../db.ts";
import {
  requireInstitutionRole,
  isDenied,
  ALL_ROLES,
} from "../../auth-helpers.ts";
import type { Context } from "npm:hono";

export const contentTreeRoutes = new Hono();

// ━━━ Helper ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function filterActiveTree(courses: Record<string, unknown>[]): Record<string, unknown>[] {
  if (!courses) return [];
  return courses
    .filter((c) => c.is_active !== false)
    .map((c) => ({
      ...c,
      semesters: !Array.isArray(c.semesters)
        ? []
        : (c.semesters as Record<string, unknown>[])
            .filter((s) => s.is_active !== false)
            .map((s) => ({
              ...s,
              sections: !Array.isArray(s.sections)
                ? []
                : (s.sections as Record<string, unknown>[])
                    .filter((sec) => sec.is_active !== false)
                    .map((sec) => ({
                      ...sec,
                      topics: !Array.isArray(sec.topics)
                        ? []
                        : (sec.topics as Record<string, unknown>[]).filter(
                            (t) => t.is_active !== false,
                          ),
                    })),
            })),
    }));
}

// ━━━ Endpoint ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

contentTreeRoutes.get(`${PREFIX}/content-tree`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const institutionId = c.req.query("institution_id");
  if (!institutionId)
    return err(c, "Missing required query param: institution_id", 400);

  // H-5 FIX: Verify caller is a member of this institution
  const roleCheck = await requireInstitutionRole(db, user.id, institutionId, ALL_ROLES);
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status);

  const { data, error } = await db
    .from("courses")
    .select(
      `
      id, name, description, order_index, is_active,
      semesters (
        id, name, order_index, is_active,
        sections (
          id, name, order_index, is_active,
          topics (
            id, name, order_index, is_active
          )
        )
      )
    `,
    )
    .eq("institution_id", institutionId)
    .eq("is_active", true)
    .order("order_index", { ascending: true })
    .order("order_index", { ascending: true, referencedTable: "semesters" })
    .order("order_index", {
      ascending: true,
      referencedTable: "semesters.sections",
    })
    .order("order_index", {
      ascending: true,
      referencedTable: "semesters.sections.topics",
    });

  if (error) return err(c, `Content tree failed: ${error.message}`, 500);
  return ok(c, filterActiveTree(data ?? []));
});

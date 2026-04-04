/**
 * routes/schedule/momentum.ts — Study momentum endpoint
 *
 * GET /schedule/momentum → { score, trend, streak }
 *
 * Auth: requires valid JWT (any role).
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, PREFIX } from "../../db.ts";
import { computeStudyMomentum } from "../../lib/scheduling-intelligence/momentum.ts";

export const momentumRoutes = new Hono();

momentumRoutes.get(`${PREFIX}/schedule/momentum`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  try {
    const result = await computeStudyMomentum(db, user.id);
    return ok(c, result);
  } catch (e) {
    return err(c, "Failed to compute momentum", 500);
  }
});

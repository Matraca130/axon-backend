/**
 * routes/schedule/momentum-score.ts — Study momentum score endpoint
 *
 * GET /schedule/momentum-score → { score, trend, streak }
 *
 * Computes a 0-100 momentum score based on session frequency,
 * review accuracy, and streak. Used by scheduling intelligence.
 *
 * Note: /schedule/momentum (momentum.ts) serves the MomentumCard dashboard
 * with a different response shape (completedToday, dueToday, etc.).
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, PREFIX } from "../../db.ts";
import { computeStudyMomentum } from "../../lib/scheduling-intelligence/momentum.ts";

export const momentumScoreRoutes = new Hono();

momentumScoreRoutes.get(`${PREFIX}/schedule/momentum-score`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  try {
    const result = await computeStudyMomentum(db, user.id);
    return ok(c, result);
  } catch (e) {
    return err(c, "Failed to compute momentum score", 500);
  }
});

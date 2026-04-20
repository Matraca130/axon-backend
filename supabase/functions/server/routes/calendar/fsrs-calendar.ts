/**
 * routes/calendar/fsrs-calendar.ts — FSRS calendar integration endpoints
 *
 * GET /calendar/workload?days=90   — projected daily card workload
 * GET /calendar/timeliness         — student timeliness profile
 *
 * Both call SECURITY DEFINER RPCs for the authenticated student.
 *
 * Sprint 0 — FSRS/BKT Calendar Integration
 * FILE: supabase/functions/server/routes/calendar/fsrs-calendar.ts
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, PREFIX } from "../../db.ts";
import { safeErr } from "../../lib/safe-error.ts";

export const fsrsCalendarRoutes = new Hono();

// ─── GET /calendar/workload ─────────────────────────────────────

fsrsCalendarRoutes.get(
  `${PREFIX}/calendar/workload`,
  async (c: Context) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    const daysParam = c.req.query("days") ?? "90";
    const days = parseInt(daysParam, 10);
    if (isNaN(days) || days < 1 || days > 365) {
      return err(c, "days must be an integer between 1 and 365", 400);
    }

    const { data, error } = await db.rpc("get_projected_daily_workload", {
      p_student_id: user.id,
      p_days_ahead: days,
    });

    if (error) {
      return safeErr(c, "Calendar workload", error);
    }

    return ok(c, data);
  },
);

// ─── GET /calendar/timeliness ───────────────────────────────────

fsrsCalendarRoutes.get(
  `${PREFIX}/calendar/timeliness`,
  async (c: Context) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    const { data, error } = await db.rpc("get_student_timeliness_profile", {
      p_student_id: user.id,
    });

    if (error) {
      return safeErr(c, "Calendar timeliness", error);
    }

    if (!data || (Array.isArray(data) && data.length === 0)) {
      return c.json({ data: null, hint: "no_reviews_in_last_90_days" });
    }

    // RPC returns a single row as an array — unwrap
    const profile = Array.isArray(data) && data.length > 0 ? data[0] : data;
    return ok(c, profile);
  },
);

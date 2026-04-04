/**
 * routes/schedule/exam-countdown.ts — Exam prep countdown endpoint
 *
 * GET /schedule/exam-prep/:examId → ExamReviewPlan[]
 *
 * Auth: requires valid JWT (student role — only own exam events via RLS).
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, PREFIX } from "../../db.ts";
import { isUuid } from "../../validate.ts";
import { planExamCountdown } from "../../lib/scheduling-intelligence/exam-countdown.ts";

export const examCountdownRoutes = new Hono();

examCountdownRoutes.get(
  `${PREFIX}/schedule/exam-prep/:examId`,
  async (c: Context) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    const examId = c.req.param("examId");
    if (!examId || !isUuid(examId)) {
      return err(c, "Valid exam ID is required", 400);
    }

    try {
      const plans = await planExamCountdown(db, user.id, examId);
      return ok(c, plans);
    } catch (e) {
      return err(c, "Failed to generate exam prep plan", 500);
    }
  },
);

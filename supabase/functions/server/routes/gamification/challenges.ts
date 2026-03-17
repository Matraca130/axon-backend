/**
 * routes/gamification/challenges.ts -- Daily/weekly challenges (Sprint 2)
 *
 * PR #108: POST /challenges/check now reads reviews_today,
 * sessions_today, correct_streak from student_stats instead of
 * COUNT queries (4 parallel queries -> 2 parallel queries).
 *
 * PR #108 FIX: POST /challenges/claim now increments
 * challenges_completed on student_stats for Challenge Hunter badges.
 *
 * Endpoints:
 *   GET  /gamification/challenges          -- Active challenges + progress
 *   GET  /gamification/challenges/history   -- Completed challenges
 *   POST /gamification/challenges/check     -- Evaluate + auto-complete
 *   POST /gamification/challenges/claim     -- Claim XP reward
 *   POST /gamification/challenges/generate  -- Generate daily challenges
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, safeJson, PREFIX, getAdminClient } from "../../db.ts";
import { isUuid } from "../../validate.ts";
import { awardXP } from "../../xp-engine.ts";
import { incrementChallengesCompleted } from "../../stat-counters.ts";
import {
  evaluateChallenge,
  selectDailyChallenges,
  CHALLENGE_TEMPLATES,
  type ChallengeProgress,
} from "../../challenge-engine.ts";

export const challengeRoutes = new Hono();

// --- GET /gamification/challenges ---

challengeRoutes.get(`${PREFIX}/gamification/challenges`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const institutionId = c.req.query("institution_id");
  if (!institutionId || !isUuid(institutionId)) {
    return err(c, "institution_id must be a valid UUID", 400);
  }

  const now = new Date().toISOString();

  const { data, error } = await db
    .from("student_challenges")
    .select("*")
    .eq("student_id", user.id)
    .eq("institution_id", institutionId)
    .is("claimed_at", null)
    .gt("expires_at", now)
    .order("created_at", { ascending: false });

  if (error) {
    return err(c, `Challenges fetch failed: ${error.message}`, 500);
  }

  return ok(c, { challenges: data ?? [], total: data?.length ?? 0 });
});

// --- GET /gamification/challenges/history ---

challengeRoutes.get(`${PREFIX}/gamification/challenges/history`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const institutionId = c.req.query("institution_id");
  if (!institutionId || !isUuid(institutionId)) {
    return err(c, "institution_id must be a valid UUID", 400);
  }

  let limit = parseInt(c.req.query("limit") ?? "20", 10);
  if (isNaN(limit) || limit < 1) limit = 20;
  if (limit > 100) limit = 100;

  const { data, error } = await db
    .from("student_challenges")
    .select("*")
    .eq("student_id", user.id)
    .eq("institution_id", institutionId)
    .not("completed_at", "is", null)
    .order("completed_at", { ascending: false })
    .limit(limit);

  if (error) {
    return err(c, `Challenge history failed: ${error.message}`, 500);
  }

  return ok(c, { history: data ?? [], total: data?.length ?? 0 });
});

// --- POST /gamification/challenges/check ---

challengeRoutes.post(`${PREFIX}/gamification/challenges/check`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const institutionId = c.req.query("institution_id");
  if (!institutionId || !isUuid(institutionId)) {
    return err(c, "institution_id must be a valid UUID", 400);
  }

  const adminDb = getAdminClient();
  const now = new Date().toISOString();

  const { data: activeChallenges, error: fetchErr } = await db
    .from("student_challenges")
    .select("*")
    .eq("student_id", user.id)
    .eq("institution_id", institutionId)
    .is("completed_at", null)
    .is("claimed_at", null)
    .gt("expires_at", now);

  if (fetchErr) {
    return err(c, `Challenges fetch failed: ${fetchErr.message}`, 500);
  }

  if (!activeChallenges || activeChallenges.length === 0) {
    return ok(c, { checked: 0, completed: 0, results: [] });
  }

  // PR #108: ONLY 2 queries now (was 4)
  const [xpResult, statsResult] = await Promise.all([
    db
      .from("student_xp")
      .select("xp_today, xp_this_week, total_xp")
      .eq("student_id", user.id)
      .eq("institution_id", institutionId)
      .maybeSingle(),
    db
      .from("student_stats")
      .select("current_streak, total_reviews, total_sessions, reviews_today, sessions_today, correct_streak")
      .eq("student_id", user.id)
      .maybeSingle(),
  ]);

  const context: Record<string, number> = {
    xp_today: (xpResult.data?.xp_today as number) ?? 0,
    xp_this_week: (xpResult.data?.xp_this_week as number) ?? 0,
    total_xp: (xpResult.data?.total_xp as number) ?? 0,
    current_streak: (statsResult.data?.current_streak as number) ?? 0,
    total_reviews: (statsResult.data?.total_reviews as number) ?? 0,
    reviews_today: (statsResult.data?.reviews_today as number) ?? 0,
    sessions_today: (statsResult.data?.sessions_today as number) ?? 0,
    correct_streak: (statsResult.data?.correct_streak as number) ?? 0,
  };

  const results: Array<{ id: string; slug: string; completed: boolean; progress_pct: number }> = [];
  let completedCount = 0;

  for (const challenge of activeChallenges) {
    const progress: ChallengeProgress = {
      challenge_slug: challenge.challenge_slug as string,
      criteria_field: challenge.criteria_field as string,
      criteria_op: challenge.criteria_op as string,
      criteria_value: challenge.criteria_value as number,
      current_value: context[challenge.criteria_field as string] ?? 0,
    };

    const evalResult = evaluateChallenge(progress);

    await adminDb
      .from("student_challenges")
      .update({
        current_value: progress.current_value,
        progress_pct: evalResult.progress_pct,
        ...(evalResult.completed ? { completed_at: now } : {}),
      })
      .eq("id", challenge.id);

    if (evalResult.completed) completedCount++;

    results.push({
      id: challenge.id as string,
      slug: challenge.challenge_slug as string,
      completed: evalResult.completed,
      progress_pct: evalResult.progress_pct,
    });
  }

  return ok(c, { checked: activeChallenges.length, completed: completedCount, results });
});

// --- POST /gamification/challenges/claim ---
// PR #108 FIX: Now increments challenges_completed counter

challengeRoutes.post(`${PREFIX}/gamification/challenges/claim`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const challengeId = body.challenge_id as string;
  if (!challengeId || !isUuid(challengeId)) {
    return err(c, "challenge_id must be a valid UUID", 400);
  }

  const institutionId = body.institution_id as string;
  if (!institutionId || !isUuid(institutionId)) {
    return err(c, "institution_id must be a valid UUID", 400);
  }

  const adminDb = getAdminClient();

  const { data: challenge, error: fetchErr } = await adminDb
    .from("student_challenges")
    .select("*")
    .eq("id", challengeId)
    .eq("student_id", user.id)
    .not("completed_at", "is", null)
    .is("claimed_at", null)
    .single();

  if (fetchErr || !challenge) {
    return err(c, "Challenge not found, not completed, or already claimed", 404);
  }

  const xpReward = challenge.xp_reward as number;
  try {
    await awardXP({
      db: adminDb,
      studentId: user.id,
      institutionId,
      action: `challenge_${challenge.challenge_slug}`,
      xpBase: xpReward,
      sourceType: "challenge",
      sourceId: challengeId,
    });
  } catch (e) {
    console.warn(`[Challenges] XP award failed for ${challengeId}:`, (e as Error).message);
  }

  const { error: claimErr } = await adminDb
    .from("student_challenges")
    .update({ claimed_at: new Date().toISOString() })
    .eq("id", challengeId);

  if (claimErr) {
    return err(c, `Claim update failed: ${claimErr.message}`, 500);
  }

  // PR #108: Increment challenges_completed for Challenge Hunter badges
  incrementChallengesCompleted(user.id);

  return ok(c, { claimed: true, challenge_slug: challenge.challenge_slug, xp_awarded: xpReward });
});

// --- POST /gamification/challenges/generate ---

challengeRoutes.post(`${PREFIX}/gamification/challenges/generate`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const institutionId = body.institution_id as string;
  if (!institutionId || !isUuid(institutionId)) {
    return err(c, "institution_id must be a valid UUID", 400);
  }

  const adminDb = getAdminClient();
  const today = new Date().toISOString().split("T")[0];

  const { count } = await adminDb
    .from("student_challenges")
    .select("id", { count: "exact", head: true })
    .eq("student_id", user.id)
    .eq("institution_id", institutionId)
    .eq("challenge_type", "daily")
    .gte("created_at", `${today}T00:00:00Z`);

  if ((count ?? 0) > 0) {
    return ok(c, { generated: 0, message: "Daily challenges already generated for today" });
  }

  const threeDaysAgo = new Date();
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

  const { data: recentChallenges } = await adminDb
    .from("student_challenges")
    .select("challenge_slug")
    .eq("student_id", user.id)
    .eq("institution_id", institutionId)
    .gte("created_at", threeDaysAgo.toISOString());

  const recentSlugs = (recentChallenges ?? []).map(
    (r: Record<string, unknown>) => r.challenge_slug as string,
  );

  const selected = selectDailyChallenges(CHALLENGE_TEMPLATES, 3, recentSlugs);

  const expiresAt = new Date();
  expiresAt.setUTCHours(23, 59, 59, 999);

  const rows = selected.map((t) => ({
    student_id: user.id,
    institution_id: institutionId,
    challenge_type: "daily",
    challenge_slug: t.slug,
    title: t.title_es,
    description: t.description_es,
    category: t.category,
    criteria_field: t.criteria_field,
    criteria_op: t.criteria_op,
    criteria_value: t.criteria_value,
    current_value: 0,
    progress_pct: 0,
    xp_reward: t.xp_reward,
    difficulty: t.difficulty,
    expires_at: expiresAt.toISOString(),
  }));

  const { data: created, error: insertErr } = await adminDb
    .from("student_challenges")
    .insert(rows)
    .select();

  if (insertErr) {
    return err(c, `Challenge generation failed: ${insertErr.message}`, 500);
  }

  return ok(c, { generated: created?.length ?? 0, challenges: created }, 201);
});

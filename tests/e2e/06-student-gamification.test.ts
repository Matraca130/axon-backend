/**
 * tests/e2e/06-student-gamification.test.ts — Student gamification E2E
 * Run: deno test tests/e2e/06-student-gamification.test.ts --allow-net --allow-env --no-check
 *
 * Tests the gamification system end-to-end:
 *   GAM-00: Login as student
 *   GAM-01: POST /gamification/onboarding → ensure gamification profile exists
 *   GAM-02: GET /gamification/profile → get initial XP state
 *   GAM-03: POST /gamification/daily-check-in → check in for today
 *   GAM-04: GET /gamification/streak-status → verify streak data returned
 *   GAM-05: GET /gamification/xp-history → verify XP transactions list
 *   GAM-06: GET /gamification/profile → verify XP may have changed after check-in
 *   GAM-07: GET /gamification/badges → list badge definitions + earned status
 *   GAM-08: POST /gamification/check-badges → trigger badge evaluation
 *   GAM-09: GET /gamification/leaderboard?period=weekly → verify student appears or list returned
 *   GAM-10: GET /gamification/leaderboard?period=daily → verify daily leaderboard
 *   GAM-11: GET /gamification/notifications → verify notification feed
 *   GAM-12: PUT /gamification/daily-goal → set daily goal minutes
 *   GAM-13: POST /gamification/goals/complete → complete a goal for bonus XP
 */
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { login, api, ENV, assertStatus, assertOk } from "../helpers/test-client.ts";

// ═══ Prerequisites ═══

const HAS_CREDS = ENV.ADMIN_EMAIL.length > 0 && ENV.ADMIN_PASSWORD.length > 0;
const HAS_INST = HAS_CREDS && ENV.INSTITUTION_ID.length > 0;

// ═══ Shared state across sequential tests ═══

let TOKEN = "";
let STUDENT_ID = "";
const INST = ENV.INSTITUTION_ID;

let initialTotalXp = 0;

// ═══ 0. Login ═══

Deno.test({
  name: "GAM-00: Login as student",
  ignore: !HAS_CREDS,
  async fn() {
    // Use TEST_USER if available, otherwise admin
    if (ENV.USER_EMAIL.length > 0 && ENV.USER_PASSWORD.length > 0) {
      const auth = await login(ENV.USER_EMAIL, ENV.USER_PASSWORD);
      TOKEN = auth.access_token;
      STUDENT_ID = auth.user.id;
    } else {
      const auth = await login(ENV.ADMIN_EMAIL, ENV.ADMIN_PASSWORD);
      TOKEN = auth.access_token;
      STUDENT_ID = auth.user.id;
    }
    assert(TOKEN.length > 0, "must obtain access token");
    assert(STUDENT_ID.length > 0, "must obtain student user id");
  },
});

// ═══ 1. Onboarding — ensure gamification profile exists ═══

Deno.test({
  name: "GAM-01: POST /gamification/onboarding ensures profile exists",
  ignore: !HAS_INST,
  async fn() {
    const r = await api.post(
      `/gamification/onboarding`,
      TOKEN,
      { institution_id: INST },
    );
    // Returns 200 if already onboarded, 201 if newly created
    assert(r.ok, `POST /gamification/onboarding should succeed, got ${r.status}: ${r.error}`);
    const body = assertOk(r) as Record<string, unknown>;
    // Either { message, already_exists: true } or { message, already_exists: false }
    assert(body.message !== undefined, "onboarding response must have message");
    assert(typeof body.already_exists === "boolean", "onboarding must indicate already_exists");
  },
});

// ═══ 2. Get initial gamification profile ═══

Deno.test({
  name: "GAM-02: GET /gamification/profile returns XP and streak data",
  ignore: !HAS_INST,
  async fn() {
    const r = await api.get(`/gamification/profile?institution_id=${INST}`, TOKEN);
    assertStatus(r, 200);
    const body = assertOk(r) as Record<string, unknown>;

    // Verify structure: xp, streak, badges_earned
    assert(body.xp !== undefined, "profile must have xp object");
    assert(body.streak !== undefined, "profile must have streak object");
    assert(typeof body.badges_earned === "number", "profile must have badges_earned count");

    const xp = body.xp as Record<string, unknown>;
    assert(typeof xp.total === "number", "xp.total must be a number");
    assert(typeof xp.today === "number", "xp.today must be a number");
    assert(typeof xp.this_week === "number", "xp.this_week must be a number");
    assert(typeof xp.level === "number", "xp.level must be a number");
    assert(typeof xp.daily_goal_minutes === "number", "xp.daily_goal_minutes must be a number");
    assert(typeof xp.daily_cap === "number", "xp.daily_cap must be a number");

    const streak = body.streak as Record<string, unknown>;
    assert(typeof streak.current === "number", "streak.current must be a number");
    assert(typeof streak.longest === "number", "streak.longest must be a number");

    // Save initial XP for later comparison
    initialTotalXp = xp.total as number;
  },
});

// ═══ 3. Daily check-in ═══

Deno.test({
  name: "GAM-03: POST /gamification/daily-check-in performs check-in",
  ignore: !HAS_INST,
  async fn() {
    const r = await api.post(
      `/gamification/daily-check-in?institution_id=${INST}`,
      TOKEN,
    );
    assert(r.ok, `POST /gamification/daily-check-in should succeed, got ${r.status}: ${r.error}`);
    const body = assertOk(r) as Record<string, unknown>;

    // Result includes events array and streak_status
    assert(body.events !== undefined, "check-in result must have events");
    assert(Array.isArray(body.events), "events must be an array");
    assert(body.streak_status !== undefined, "check-in result must have streak_status");

    const streakStatus = body.streak_status as Record<string, unknown>;
    assert(typeof streakStatus.current_streak === "number", "streak_status must have current_streak");
  },
});

// ═══ 4. Streak status ═══

Deno.test({
  name: "GAM-04: GET /gamification/streak-status returns streak data",
  ignore: !HAS_INST,
  async fn() {
    const r = await api.get(`/gamification/streak-status?institution_id=${INST}`, TOKEN);
    assertStatus(r, 200);
    const body = assertOk(r) as Record<string, unknown>;

    // computeStreakStatus returns an object with current_streak, longest_streak, etc.
    assert(typeof body.current_streak === "number", "must have current_streak");
    assert(typeof body.longest_streak === "number", "must have longest_streak");
  },
});

// ═══ 5. XP history ═══

Deno.test({
  name: "GAM-05: GET /gamification/xp-history returns transaction list",
  ignore: !HAS_INST,
  async fn() {
    const r = await api.get(`/gamification/xp-history?institution_id=${INST}`, TOKEN);
    assertStatus(r, 200);
    const body = assertOk(r) as Record<string, unknown>;

    assert(body.items !== undefined, "xp-history must have items");
    assert(Array.isArray(body.items), "items must be an array");
    assert(typeof body.total === "number", "xp-history must have total count");
    assert(typeof body.limit === "number", "xp-history must have limit");
    assert(typeof body.offset === "number", "xp-history must have offset");
  },
});

// ═══ 6. Profile after check-in (verify XP may have changed) ═══

Deno.test({
  name: "GAM-06: GET /gamification/profile after check-in shows current state",
  ignore: !HAS_INST,
  async fn() {
    const r = await api.get(`/gamification/profile?institution_id=${INST}`, TOKEN);
    assertStatus(r, 200);
    const body = assertOk(r) as Record<string, unknown>;

    const xp = body.xp as Record<string, unknown>;
    assert(typeof xp.total === "number", "xp.total must be a number");
    // After check-in, XP should be >= initial (daily check-in awards XP if streak didn't break
    // and it wasn't already checked in today)
    assert(
      (xp.total as number) >= initialTotalXp,
      `XP after check-in (${xp.total}) should be >= initial (${initialTotalXp})`,
    );
  },
});

// ═══ 7. Badges list ═══

Deno.test({
  name: "GAM-07: GET /gamification/badges returns badge definitions with earned status",
  ignore: !HAS_INST,
  async fn() {
    const r = await api.get(`/gamification/badges`, TOKEN);
    assertStatus(r, 200);
    const body = assertOk(r) as Record<string, unknown>;

    assert(body.badges !== undefined, "badges response must have badges array");
    assert(Array.isArray(body.badges), "badges must be an array");
    assert(typeof body.total === "number", "badges response must have total");
    assert(typeof body.earned_count === "number", "badges response must have earned_count");

    // Each badge should have earned boolean and earned_at
    const badges = body.badges as Record<string, unknown>[];
    if (badges.length > 0) {
      const first = badges[0];
      assert(typeof first.earned === "boolean", "badge must have earned boolean");
      assert(first.name !== undefined, "badge must have name");
    }
  },
});

// ═══ 8. Check badges (trigger evaluation) ═══

Deno.test({
  name: "GAM-08: POST /gamification/check-badges triggers badge evaluation",
  ignore: !HAS_INST,
  async fn() {
    const r = await api.post(
      `/gamification/check-badges?institution_id=${INST}`,
      TOKEN,
    );
    assert(r.ok, `POST /gamification/check-badges should succeed, got ${r.status}: ${r.error}`);
    const body = assertOk(r) as Record<string, unknown>;

    assert(body.new_badges !== undefined, "check-badges must have new_badges array");
    assert(Array.isArray(body.new_badges), "new_badges must be an array");
    assert(typeof body.checked === "number", "check-badges must have checked count");
    assert(typeof body.awarded === "number", "check-badges must have awarded count");
  },
});

// ═══ 9. Weekly leaderboard ═══

Deno.test({
  name: "GAM-09: GET /gamification/leaderboard?period=weekly returns leaderboard",
  ignore: !HAS_INST,
  async fn() {
    const r = await api.get(
      `/gamification/leaderboard?institution_id=${INST}&period=weekly`,
      TOKEN,
    );
    assertStatus(r, 200);
    const body = assertOk(r) as Record<string, unknown>;

    assert(body.leaderboard !== undefined, "leaderboard response must have leaderboard array");
    assert(Array.isArray(body.leaderboard), "leaderboard must be an array");
    assertEquals(body.period, "weekly", "period must be weekly");
    // my_rank is number or null (null if student has no XP this week)
    assert(
      body.my_rank === null || typeof body.my_rank === "number",
      "my_rank must be number or null",
    );
  },
});

// ═══ 10. Daily leaderboard ═══

Deno.test({
  name: "GAM-10: GET /gamification/leaderboard?period=daily returns daily leaderboard",
  ignore: !HAS_INST,
  async fn() {
    const r = await api.get(
      `/gamification/leaderboard?institution_id=${INST}&period=daily`,
      TOKEN,
    );
    assertStatus(r, 200);
    const body = assertOk(r) as Record<string, unknown>;

    assert(body.leaderboard !== undefined, "leaderboard response must have leaderboard array");
    assert(Array.isArray(body.leaderboard), "leaderboard must be an array");
    assertEquals(body.period, "daily", "period must be daily");
  },
});

// ═══ 11. Notifications ═══

Deno.test({
  name: "GAM-11: GET /gamification/notifications returns notification feed",
  ignore: !HAS_INST,
  async fn() {
    const r = await api.get(
      `/gamification/notifications?institution_id=${INST}`,
      TOKEN,
    );
    assertStatus(r, 200);
    const body = assertOk(r) as Record<string, unknown>;

    assert(body.notifications !== undefined, "notifications response must have notifications");
    assert(Array.isArray(body.notifications), "notifications must be an array");
    assert(typeof body.total === "number", "notifications must have total count");
  },
});

// ═══ 12. Set daily goal ═══

Deno.test({
  name: "GAM-12: PUT /gamification/daily-goal updates daily goal minutes",
  ignore: !HAS_INST,
  async fn() {
    const r = await api.put(
      `/gamification/daily-goal`,
      TOKEN,
      { institution_id: INST, daily_goal_minutes: 15 },
    );
    assert(r.ok, `PUT /gamification/daily-goal should succeed, got ${r.status}: ${r.error}`);
    const body = assertOk(r) as Record<string, unknown>;
    assert(body.daily_goal_minutes !== undefined, "response must include daily_goal_minutes");
    assertEquals(body.daily_goal_minutes, 15, "daily_goal_minutes should be updated to 15");
  },
});

// ═══ 13. Complete a goal for bonus XP ═══

Deno.test({
  name: "GAM-13: POST /gamification/goals/complete awards bonus XP",
  ignore: !HAS_INST,
  async fn() {
    const r = await api.post(
      `/gamification/goals/complete`,
      TOKEN,
      { institution_id: INST, goal_type: "daily_xp" },
    );
    // May return 409 if goal was already completed today — that's ok
    if (r.status === 409) {
      // Goal already completed today — valid state, not an error
      const body = r.raw as Record<string, unknown>;
      assert(
        typeof body.error === "string" || typeof body.message === "string",
        "409 response must have error/message explaining duplicate",
      );
      return;
    }
    assert(r.ok, `POST /gamification/goals/complete should succeed, got ${r.status}: ${r.error}`);
    const body = assertOk(r) as Record<string, unknown>;
    assertEquals(body.goal_type, "daily_xp", "goal_type must match");
    assert(typeof body.xp_awarded === "number", "must have xp_awarded");
    assert((body.xp_awarded as number) > 0, "xp_awarded must be > 0");
  },
});

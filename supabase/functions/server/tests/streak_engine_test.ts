/**
 * Tests for streak-engine.ts — Streak lifecycle management for Axon v4.4
 *
 * Tests cover:
 *   1. computeStreakStatus: state derivation from mock data
 *   2. _computeCheckInDecision: ALL 5 flow paths (pure function, no DB)
 *   3. Date helpers: todayUTC, yesterdayUTC, daysBetween
 *   4. Edge cases: null dates, first-time students, multi-day freeze
 *
 * Strategy: computeStreakStatus uses mock DB (same as before).
 * _computeCheckInDecision is a PURE function — no DB needed at all.
 *
 * Run: deno test supabase/functions/server/tests/streak_engine_test.ts
 *
 * AUDIT FIX: T-1 + T-2 — Added tests for performDailyCheckIn via
 * exported _computeCheckInDecision (pure function, testable).
 */

import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// ─── Environment Setup ───
Deno.env.set("SUPABASE_URL", "http://127.0.0.1:1");
Deno.env.set("SUPABASE_ANON_KEY", "fake-anon-key-for-testing");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "fake-service-role-key-for-testing");

const {
  computeStreakStatus,
  _computeCheckInDecision,
  todayUTC,
  yesterdayUTC,
  daysBetween,
} = await import("../streak-engine.ts");

// ═══════════════════════════════════════════════════════════════
// Date Helper Utilities (test-local)
// ═══════════════════════════════════════════════════════════════

function daysAgoUTC(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().split("T")[0];
}

// ═══════════════════════════════════════════════════════════════
// Mock Supabase Client for computeStreakStatus
// ═══════════════════════════════════════════════════════════════

function mockStreakDbSimple(opts: {
  stats?: {
    current_streak: number;
    longest_streak: number;
    last_study_date: string | null;
  } | null;
  freezeCount?: number;
}): any {
  const { stats = null, freezeCount = 0 } = opts;
  let currentTable = "";
  let isCountQuery = false;

  const makeChain = (): any => {
    const c: Record<string, any> = {};
    const methods = [
      "eq", "neq", "gt", "lt", "gte", "lte",
      "like", "ilike", "is", "in", "not", "or",
      "order", "limit", "range", "filter",
    ];
    for (const m of methods) {
      c[m] = () => c;
    }
    c.select = (_col: string, opts2?: any) => {
      if (opts2?.head) isCountQuery = true;
      return c;
    };
    c.maybeSingle = () => {
      if (currentTable === "student_stats") {
        return Promise.resolve({ data: stats, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    };
    c.then = (resolve: any, reject?: any) => {
      if (isCountQuery && currentTable === "streak_freezes") {
        return Promise.resolve({ count: freezeCount, error: null }).then(resolve, reject);
      }
      if (currentTable === "student_stats") {
        return Promise.resolve({ data: stats, error: null }).then(resolve, reject);
      }
      return Promise.resolve({ data: null, error: null }).then(resolve, reject);
    };
    return c;
  };

  return {
    from: (table: string) => {
      currentTable = table;
      isCountQuery = false;
      return makeChain();
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// 1. computeStreakStatus — State Derivations
// ═══════════════════════════════════════════════════════════════

Deno.test("computeStreakStatus: new student (no stats) returns zeros", async () => {
  const db = mockStreakDbSimple({ stats: null, freezeCount: 0 });
  const status = await computeStreakStatus(db, "student-1", "inst-1");

  assertEquals(status.current_streak, 0);
  assertEquals(status.longest_streak, 0);
  assertEquals(status.last_study_date, null);
  assertEquals(status.freezes_available, 0);
  assertEquals(status.repair_eligible, false);
  assertEquals(status.streak_at_risk, false);
  assertEquals(status.studied_today, false);
  assertEquals(status.days_since_last_study, null);
});

Deno.test("computeStreakStatus: studied today = safe", async () => {
  const today = todayUTC();
  const db = mockStreakDbSimple({
    stats: { current_streak: 5, longest_streak: 10, last_study_date: today },
    freezeCount: 1,
  });
  const status = await computeStreakStatus(db, "student-1", "inst-1");

  assertEquals(status.studied_today, true);
  assertEquals(status.streak_at_risk, false);
});

Deno.test("computeStreakStatus: yesterday + no freeze = at risk", async () => {
  const yesterday = yesterdayUTC();
  const db = mockStreakDbSimple({
    stats: { current_streak: 7, longest_streak: 7, last_study_date: yesterday },
    freezeCount: 0,
  });
  const status = await computeStreakStatus(db, "student-1", "inst-1");

  assertEquals(status.studied_today, false);
  assertEquals(status.streak_at_risk, true);
  assertEquals(status.days_since_last_study, 1);
});

Deno.test("computeStreakStatus: yesterday + has freeze = not at risk", async () => {
  const yesterday = yesterdayUTC();
  const db = mockStreakDbSimple({
    stats: { current_streak: 7, longest_streak: 7, last_study_date: yesterday },
    freezeCount: 2,
  });
  const status = await computeStreakStatus(db, "student-1", "inst-1");

  assertEquals(status.streak_at_risk, false);
  assertEquals(status.freezes_available, 2);
});

Deno.test("computeStreakStatus: broken streak, recent break = repair eligible", async () => {
  const yesterday = yesterdayUTC();
  const db = mockStreakDbSimple({
    stats: { current_streak: 0, longest_streak: 15, last_study_date: yesterday },
    freezeCount: 0,
  });
  const status = await computeStreakStatus(db, "student-1", "inst-1");

  assertEquals(status.current_streak, 0);
  assertEquals(status.repair_eligible, true);
});

Deno.test("computeStreakStatus: broken streak, old break = not repair eligible", async () => {
  const fiveDaysAgo = daysAgoUTC(5);
  const db = mockStreakDbSimple({
    stats: { current_streak: 0, longest_streak: 20, last_study_date: fiveDaysAgo },
    freezeCount: 0,
  });
  const status = await computeStreakStatus(db, "student-1", "inst-1");

  assertEquals(status.repair_eligible, false);
});

Deno.test("computeStreakStatus: active streak never repair eligible", async () => {
  const today = todayUTC();
  const db = mockStreakDbSimple({
    stats: { current_streak: 5, longest_streak: 5, last_study_date: today },
    freezeCount: 0,
  });
  const status = await computeStreakStatus(db, "student-1", "inst-1");

  assertEquals(status.repair_eligible, false);
});

Deno.test("computeStreakStatus: 3 days ago, streak > 0 but not exactly at_risk", async () => {
  const threeDaysAgo = daysAgoUTC(3);
  const db = mockStreakDbSimple({
    stats: { current_streak: 5, longest_streak: 10, last_study_date: threeDaysAgo },
    freezeCount: 0,
  });
  const status = await computeStreakStatus(db, "student-1", "inst-1");

  assertEquals(status.streak_at_risk, false);
  assertEquals(status.days_since_last_study, 3);
});

Deno.test("StreakStatus: has all required fields with correct types", async () => {
  const db = mockStreakDbSimple({
    stats: { current_streak: 3, longest_streak: 10, last_study_date: todayUTC() },
    freezeCount: 1,
  });
  const status = await computeStreakStatus(db, "s1", "i1");

  assertEquals(typeof status.current_streak, "number");
  assertEquals(typeof status.longest_streak, "number");
  assertEquals(typeof status.freezes_available, "number");
  assertEquals(typeof status.repair_eligible, "boolean");
  assertEquals(typeof status.streak_at_risk, "boolean");
  assertEquals(typeof status.studied_today, "boolean");
});

// ═══════════════════════════════════════════════════════════════
// 2. _computeCheckInDecision — Pure Decision Logic (T-1 FIX)
// ═══════════════════════════════════════════════════════════════

Deno.test("checkInDecision: already studied today → idempotent", () => {
  const d = _computeCheckInDecision(5, 10, "2026-03-13", [], "2026-03-13");

  assertEquals(d.events.length, 1);
  assertEquals(d.events[0].type, "already_checked_in");
  assertEquals(d.newStreak, 5); // unchanged
  assertEquals(d.freezeIdsToConsume.length, 0);
});

Deno.test("checkInDecision: studied yesterday → streak incremented", () => {
  const d = _computeCheckInDecision(5, 10, "2026-03-12", [], "2026-03-13");

  assertEquals(d.events.length, 1);
  assertEquals(d.events[0].type, "streak_incremented");
  assertEquals(d.newStreak, 6);
  assertEquals(d.newLongest, 10); // didn't beat longest
});

Deno.test("checkInDecision: studied yesterday + beats longest → updates longest", () => {
  const d = _computeCheckInDecision(10, 10, "2026-03-12", [], "2026-03-13");

  assertEquals(d.newStreak, 11);
  assertEquals(d.newLongest, 11);
});

Deno.test("checkInDecision: first time ever → streak started", () => {
  const d = _computeCheckInDecision(0, 0, null, [], "2026-03-13");

  assertEquals(d.events.length, 1);
  assertEquals(d.events[0].type, "streak_started");
  assertEquals(d.newStreak, 1);
  assertEquals(d.newLongest, 1);
});

Deno.test("checkInDecision: missed 1 day (2 days gap), 1 freeze → consume 1 freeze", () => {
  // Last study: 2 days ago → daysMissed=2, freezesNeeded=1
  const d = _computeCheckInDecision(
    5, 10, "2026-03-11",
    ["freeze-1", "freeze-2"],
    "2026-03-13",
  );

  assertEquals(d.events.length, 1);
  assertEquals(d.events[0].type, "freeze_consumed");
  assertEquals(d.freezeIdsToConsume.length, 1);
  assertEquals(d.freezeIdsToConsume[0], "freeze-1"); // oldest first
  assertEquals(d.freezeUsedOnDates.length, 1);
  assertEquals(d.freezeUsedOnDates[0], "2026-03-12"); // covers the missed day
  assertEquals(d.newStreak, 6); // maintained + incremented
});

// ── T-2 FIX: Multi-day freeze scenarios ──

Deno.test("checkInDecision: BUG-1 — missed 3 days, has 2 freezes → BREAK (not enough)", () => {
  // Last study: 4 days ago → daysMissed=4, freezesNeeded=3
  // Only 2 freezes available → NOT ENOUGH → streak breaks
  const d = _computeCheckInDecision(
    15, 20, "2026-03-09",
    ["freeze-1", "freeze-2"],
    "2026-03-13",
  );

  assertEquals(d.events.length, 1);
  assertEquals(d.events[0].type, "streak_broken");
  assertEquals(d.newStreak, 1); // reset to 1 (today)
  assertEquals(d.freezeIdsToConsume.length, 0); // no freezes consumed on break
  assertEquals((d.events[0].data as any).lost_streak, 15);
  assertEquals((d.events[0].data as any).freezes_needed, 3);
  assertEquals((d.events[0].data as any).freezes_available, 2);
});

Deno.test("checkInDecision: BUG-1 — missed 3 days, has 3 freezes → consume all 3", () => {
  // Last study: 4 days ago → daysMissed=4, freezesNeeded=3
  // Exactly 3 freezes → consume all, maintain streak
  const d = _computeCheckInDecision(
    15, 20, "2026-03-09",
    ["freeze-1", "freeze-2", "freeze-3"],
    "2026-03-13",
  );

  assertEquals(d.events.length, 1);
  assertEquals(d.events[0].type, "freeze_consumed");
  assertEquals(d.freezeIdsToConsume.length, 3);
  assertEquals(d.freezeIdsToConsume, ["freeze-1", "freeze-2", "freeze-3"]);
  assertEquals(d.freezeUsedOnDates.length, 3);
  // Should cover March 12, 11, 10 (the 3 missed days)
  assertEquals(d.freezeUsedOnDates, ["2026-03-12", "2026-03-11", "2026-03-10"]);
  assertEquals(d.newStreak, 16); // maintained + incremented
  assertEquals((d.events[0].data as any).freezes_consumed, 3);
  assertEquals((d.events[0].data as any).freezes_remaining, 0);
});

Deno.test("checkInDecision: BUG-1 — missed 3 days, has 5 freezes → consume only 3", () => {
  // Last study: 4 days ago → daysMissed=4, freezesNeeded=3
  // 5 freezes available → consume 3, keep 2
  const d = _computeCheckInDecision(
    10, 15, "2026-03-09",
    ["f1", "f2", "f3", "f4", "f5"],
    "2026-03-13",
  );

  assertEquals(d.events[0].type, "freeze_consumed");
  assertEquals(d.freezeIdsToConsume.length, 3); // only 3, not all 5
  assertEquals(d.freezeIdsToConsume, ["f1", "f2", "f3"]);
  assertEquals((d.events[0].data as any).freezes_remaining, 2);
  assertEquals(d.newStreak, 11);
});

Deno.test("checkInDecision: missed 1 day, has 0 freezes → break", () => {
  // daysMissed=2, freezesNeeded=1, available=0
  const d = _computeCheckInDecision(
    7, 7, "2026-03-11",
    [],
    "2026-03-13",
  );

  assertEquals(d.events[0].type, "streak_broken");
  assertEquals(d.newStreak, 1);
  assertEquals((d.events[0].data as any).lost_streak, 7);
});

Deno.test("checkInDecision: missed 7 days, has 6 freezes → break (need 6, have 6... wait)", () => {
  // Last study: 7 days ago → daysMissed=7, freezesNeeded=6
  // 6 freezes → EXACTLY enough
  const freezes = ["f1", "f2", "f3", "f4", "f5", "f6"];
  const d = _computeCheckInDecision(
    30, 30, "2026-03-06",
    freezes,
    "2026-03-13",
  );

  assertEquals(d.events[0].type, "freeze_consumed");
  assertEquals(d.freezeIdsToConsume.length, 6);
  assertEquals(d.newStreak, 31); // maintained!
  assertEquals(d.newLongest, 31); // new record
});

Deno.test("checkInDecision: missed 7 days, has 5 freezes → break (need 6, have 5)", () => {
  const freezes = ["f1", "f2", "f3", "f4", "f5"];
  const d = _computeCheckInDecision(
    30, 30, "2026-03-06",
    freezes,
    "2026-03-13",
  );

  assertEquals(d.events[0].type, "streak_broken");
  assertEquals(d.newStreak, 1);
  assertEquals((d.events[0].data as any).freezes_needed, 6);
  assertEquals((d.events[0].data as any).freezes_available, 5);
});

Deno.test("checkInDecision: freeze_consumed message is singular for 1 freeze", () => {
  const d = _computeCheckInDecision(
    5, 10, "2026-03-11",
    ["freeze-1"],
    "2026-03-13",
  );

  assertEquals(d.events[0].type, "freeze_consumed");
  assertEquals(
    d.events[0].message.includes("1 streak freeze"),
    true,
    "Should use singular form",
  );
});

Deno.test("checkInDecision: freeze_consumed message is plural for 2+ freezes", () => {
  const d = _computeCheckInDecision(
    5, 10, "2026-03-10",
    ["f1", "f2"],
    "2026-03-13",
  );

  assertEquals(d.events[0].type, "freeze_consumed");
  assertEquals(
    d.events[0].message.includes("2 streak freezes"),
    true,
    "Should use plural form",
  );
});

// ═══════════════════════════════════════════════════════════════
// 3. Date Helpers
// ═══════════════════════════════════════════════════════════════

Deno.test("todayUTC: returns YYYY-MM-DD format", () => {
  const today = todayUTC();
  assertEquals(/^\d{4}-\d{2}-\d{2}$/.test(today), true);
});

Deno.test("yesterdayUTC: different from today", () => {
  const yesterday = yesterdayUTC();
  const today = todayUTC();
  assertEquals(yesterday !== today, true);
});

Deno.test("daysBetween: same day = 0", () => {
  assertEquals(daysBetween("2026-03-13", "2026-03-13"), 0);
});

Deno.test("daysBetween: consecutive days = 1", () => {
  assertEquals(daysBetween("2026-03-12", "2026-03-13"), 1);
});

Deno.test("daysBetween: week = 7", () => {
  assertEquals(daysBetween("2026-03-06", "2026-03-13"), 7);
});

Deno.test("daysBetween: null dateA = null", () => {
  assertEquals(daysBetween(null, "2026-03-13"), null);
});

Deno.test("daysBetween: invalid date = null", () => {
  assertEquals(daysBetween("not-a-date", "2026-03-13"), null);
});

Deno.test("daysBetween: cross-month", () => {
  assertEquals(daysBetween("2026-02-28", "2026-03-01"), 1);
});

Deno.test("daysAgoUTC(0) = todayUTC()", () => {
  assertEquals(daysAgoUTC(0), todayUTC());
});

Deno.test("daysAgoUTC(1) = yesterdayUTC()", () => {
  assertEquals(daysAgoUTC(1), yesterdayUTC());
});

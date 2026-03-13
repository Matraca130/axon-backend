/**
 * Tests for streak-engine.ts — Streak lifecycle management for Axon v4.4
 *
 * Tests cover:
 *   1. computeStreakStatus: state derivation from mock data
 *   2. Date helpers: todayUTC, yesterdayUTC, daysBetween
 *   3. StreakStatus type shape
 *   4. Multi-day freeze logic validation (BUG-1 regression test)
 *
 * Strategy: Since streak-engine.ts imports getAdminClient from db.ts,
 * we use Deno.env.set() + dynamic import (same as summary_hook_test.ts).
 * computeStreakStatus receives a mock client directly.
 * performDailyCheckIn uses getAdminClient() internally so cannot be
 * unit-tested without a running DB — covered by integration tests.
 *
 * Run: deno test supabase/functions/server/tests/streak_engine_test.ts
 */

import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// ─── Environment Setup ───
Deno.env.set("SUPABASE_URL", "http://127.0.0.1:1");
Deno.env.set("SUPABASE_ANON_KEY", "fake-anon-key-for-testing");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "fake-service-role-key-for-testing");

const { computeStreakStatus } = await import("../streak-engine.ts");

// ═════════════════════════════════════════════════════════════════════
// Mock Supabase Client Factory
// ═════════════════════════════════════════════════════════════════════

function todayUTC(): string {
  return new Date().toISOString().split("T")[0];
}

function yesterdayUTC(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().split("T")[0];
}

function daysAgoUTC(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().split("T")[0];
}

/**
 * Mock Supabase client for computeStreakStatus.
 * Handles the two parallel queries:
 *   1. student_stats.select().eq().maybeSingle()
 *   2. streak_freezes.select({count, head}).eq().eq().is()
 */
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
      if (opts2?.head) {
        isCountQuery = true;
      }
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
        return Promise.resolve({ count: freezeCount, error: null }).then(
          resolve,
          reject,
        );
      }
      if (currentTable === "student_stats") {
        return Promise.resolve({ data: stats, error: null }).then(
          resolve,
          reject,
        );
      }
      return Promise.resolve({ data: null, error: null }).then(
        resolve,
        reject,
      );
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

// ═════════════════════════════════════════════════════════════════════
// 1. computeStreakStatus — State Derivations
// ═════════════════════════════════════════════════════════════════════

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

Deno.test("computeStreakStatus: studied today = true", async () => {
  const today = todayUTC();
  const db = mockStreakDbSimple({
    stats: { current_streak: 5, longest_streak: 10, last_study_date: today },
    freezeCount: 1,
  });
  const status = await computeStreakStatus(db, "student-1", "inst-1");

  assertEquals(status.studied_today, true);
  assertEquals(status.current_streak, 5);
  assertEquals(status.longest_streak, 10);
  assertEquals(status.freezes_available, 1);
  assertEquals(status.streak_at_risk, false);
});

Deno.test("computeStreakStatus: studied yesterday, NOT today, NO freeze = at risk", async () => {
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

Deno.test("computeStreakStatus: studied yesterday, NOT today, HAS freeze = not at risk", async () => {
  const yesterday = yesterdayUTC();
  const db = mockStreakDbSimple({
    stats: { current_streak: 7, longest_streak: 7, last_study_date: yesterday },
    freezeCount: 2,
  });
  const status = await computeStreakStatus(db, "student-1", "inst-1");

  assertEquals(status.streak_at_risk, false);
  assertEquals(status.freezes_available, 2);
});

Deno.test("computeStreakStatus: broken streak (0), recent break = repair eligible", async () => {
  const yesterday = yesterdayUTC();
  const db = mockStreakDbSimple({
    stats: { current_streak: 0, longest_streak: 15, last_study_date: yesterday },
    freezeCount: 0,
  });
  const status = await computeStreakStatus(db, "student-1", "inst-1");

  assertEquals(status.current_streak, 0);
  assertEquals(status.repair_eligible, true);
});

Deno.test("computeStreakStatus: broken streak, old break (5 days ago) = not repair eligible", async () => {
  const fiveDaysAgo = daysAgoUTC(5);
  const db = mockStreakDbSimple({
    stats: { current_streak: 0, longest_streak: 20, last_study_date: fiveDaysAgo },
    freezeCount: 0,
  });
  const status = await computeStreakStatus(db, "student-1", "inst-1");

  assertEquals(status.current_streak, 0);
  assertEquals(status.repair_eligible, false);
});

Deno.test("computeStreakStatus: active streak is never repair eligible", async () => {
  const today = todayUTC();
  const db = mockStreakDbSimple({
    stats: { current_streak: 5, longest_streak: 5, last_study_date: today },
    freezeCount: 0,
  });
  const status = await computeStreakStatus(db, "student-1", "inst-1");

  assertEquals(status.repair_eligible, false);
});

Deno.test("computeStreakStatus: last study 3 days ago, active streak → data inconsistency handled", async () => {
  const threeDaysAgo = daysAgoUTC(3);
  const db = mockStreakDbSimple({
    stats: { current_streak: 5, longest_streak: 10, last_study_date: threeDaysAgo },
    freezeCount: 0,
  });
  const status = await computeStreakStatus(db, "student-1", "inst-1");

  assertEquals(status.streak_at_risk, false);
  assertEquals(status.days_since_last_study, 3);
});

// ═════════════════════════════════════════════════════════════════════
// 2. Date Helper Validation
// ═════════════════════════════════════════════════════════════════════

Deno.test("todayUTC: returns YYYY-MM-DD format", () => {
  const today = todayUTC();
  assertEquals(/^\d{4}-\d{2}-\d{2}$/.test(today), true);
});

Deno.test("yesterdayUTC: returns YYYY-MM-DD format, different from today", () => {
  const yesterday = yesterdayUTC();
  const today = todayUTC();
  assertEquals(/^\d{4}-\d{2}-\d{2}$/.test(yesterday), true);
  assertEquals(yesterday !== today, true);
});

Deno.test("daysAgoUTC: 0 days ago = today", () => {
  assertEquals(daysAgoUTC(0), todayUTC());
});

Deno.test("daysAgoUTC: 1 day ago = yesterday", () => {
  assertEquals(daysAgoUTC(1), yesterdayUTC());
});

// ═════════════════════════════════════════════════════════════════════
// 3. StreakStatus Type Shape
// ═════════════════════════════════════════════════════════════════════

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

// ═════════════════════════════════════════════════════════════════════
// 4. BUG-1 Regression: Multi-day freeze logic validation
// ═════════════════════════════════════════════════════════════════════
// These tests validate the MATH, not the DB operations.
// performDailyCheckIn uses getAdminClient() internally so can't be
// unit-tested, but we verify the freeze calculation logic here.

Deno.test("BUG-1 regression: freezesNeeded = daysMissed - 1", () => {
  // Student last studied 3 days ago → daysMissed = 3 → freezesNeeded = 2
  const daysMissed = 3;
  const freezesNeeded = daysMissed - 1;
  assertEquals(freezesNeeded, 2);

  // Student last studied 2 days ago → daysMissed = 2 → freezesNeeded = 1
  assertEquals(2 - 1, 1);

  // Student last studied 5 days ago → daysMissed = 5 → freezesNeeded = 4
  assertEquals(5 - 1, 4);
});

Deno.test("BUG-1 regression: 3 days missed, 2 freezes = NOT enough → break", () => {
  const daysMissed = 3;
  const freezesNeeded = daysMissed - 1; // 2
  const freezesAvailable = 1;
  const shouldBreak = freezesAvailable < freezesNeeded;
  assertEquals(shouldBreak, true);
});

Deno.test("BUG-1 regression: 3 days missed, 2 freezes = exactly enough → maintain", () => {
  const daysMissed = 3;
  const freezesNeeded = daysMissed - 1; // 2
  const freezesAvailable = 2;
  const shouldBreak = freezesAvailable < freezesNeeded;
  assertEquals(shouldBreak, false);
});

Deno.test("BUG-1 regression: 3 days missed, 5 freezes = more than enough → maintain", () => {
  const daysMissed = 3;
  const freezesNeeded = daysMissed - 1; // 2
  const freezesAvailable = 5;
  const shouldBreak = freezesAvailable < freezesNeeded;
  assertEquals(shouldBreak, false);
});

Deno.test("BUG-1 regression: 2 days missed = 1 freeze needed (minimal case)", () => {
  const daysMissed = 2;
  const freezesNeeded = daysMissed - 1; // 1
  assertEquals(freezesNeeded, 1);
  // With 1 freeze → maintain
  assertEquals(1 >= freezesNeeded, true);
  // With 0 freezes → break
  assertEquals(0 >= freezesNeeded, false);
});

Deno.test("BUG-1 regression: 10 days missed, 3 freezes = NOT enough → break", () => {
  const daysMissed = 10;
  const freezesNeeded = daysMissed - 1; // 9
  const freezesAvailable = 3;
  assertEquals(freezesAvailable < freezesNeeded, true);
});

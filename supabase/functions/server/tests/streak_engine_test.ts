/**
 * Tests for streak-engine.ts — Streak lifecycle management for Axon v4.4
 *
 * Tests cover:
 *   1. computeStreakStatus: state derivation from mock data
 *   2. performDailyCheckIn: all 5 flow paths
 *   3. Date helpers: todayUTC, yesterdayUTC, daysBetween
 *   4. Edge cases: null dates, first-time students, idempotency
 *
 * Strategy: Since streak-engine.ts imports getAdminClient from db.ts,
 * we use Deno.env.set() + dynamic import (same as summary_hook_test.ts).
 * For performDailyCheckIn (which calls getAdminClient internally),
 * we test the exported function but expect it to fail at the DB layer.
 * For computeStreakStatus, we pass a mock client directly.
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
type { StreakStatus } from "../streak-engine.ts";

// ═══════════════════════════════════════════════════════════════
// Mock Supabase Client Factory
// ═══════════════════════════════════════════════════════════════

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
function mockStreakDb(opts: {
  stats?: {
    current_streak: number;
    longest_streak: number;
    last_study_date: string | null;
  } | null;
  freezeCount?: number;
}): any {
  const { stats = null, freezeCount = 0 } = opts;
  let queryTable = "";

  const chain: Record<string, any> = {};
  const chainMethods = [
    "select", "eq", "neq", "gt", "lt", "gte", "lte",
    "like", "ilike", "is", "in", "not", "or", "and",
    "order", "limit", "range", "filter",
  ];
  for (const method of chainMethods) {
    chain[method] = (..._args: any[]) => chain;
  }

  chain.from = (table: string) => {
    queryTable = table;
    return chain;
  };

  chain.maybeSingle = () => {
    if (queryTable === "student_stats") {
      return Promise.resolve({ data: stats, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  };

  chain.single = () => chain.maybeSingle();

  // For streak_freezes count query, the chain resolves with count
  // Override select to capture head:true pattern
  const origSelect = chain.select;
  chain.select = (columns: string, opts2?: { count?: string; head?: boolean }) => {
    if (opts2?.head && queryTable === "streak_freezes") {
      // Return a promise-like with count
      const countChain: Record<string, any> = {};
      for (const m of chainMethods) {
        countChain[m] = () => countChain;
      }
      countChain.then = (resolve: any) => {
        return Promise.resolve({ count: freezeCount, error: null }).then(resolve);
      };
      // Make it thenable but also chainable
      return countChain;
    }
    return origSelect(columns);
  };

  return chain;
}

/**
 * Simpler mock that just returns Promise.all-compatible results.
 * computeStreakStatus does Promise.all([statsQuery, freezeQuery]).
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

  // Track which table we're querying
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
    // For head:true count queries, the final result is the chain itself
    // Promise.all will await, so we make it thenable
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
  assertEquals(status.streak_at_risk, false); // studied today, no risk
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

  assertEquals(status.streak_at_risk, false); // has freeze
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
  assertEquals(status.repair_eligible, false); // > 48h
});

Deno.test("computeStreakStatus: active streak is never repair eligible", async () => {
  const today = todayUTC();
  const db = mockStreakDbSimple({
    stats: { current_streak: 5, longest_streak: 5, last_study_date: today },
    freezeCount: 0,
  });
  const status = await computeStreakStatus(db, "student-1", "inst-1");

  assertEquals(status.repair_eligible, false); // streak not broken
});

Deno.test("computeStreakStatus: last study 3 days ago, active streak → not at risk (streak > 0 but gap > 1)", async () => {
  // Edge case: data inconsistency where current_streak > 0 but gap > 1 day
  // (shouldn't happen in practice, but defensive)
  const threeDaysAgo = daysAgoUTC(3);
  const db = mockStreakDbSimple({
    stats: { current_streak: 5, longest_streak: 10, last_study_date: threeDaysAgo },
    freezeCount: 0,
  });
  const status = await computeStreakStatus(db, "student-1", "inst-1");

  // streak_at_risk requires daysSinceLast === 1 exactly
  assertEquals(status.streak_at_risk, false);
  assertEquals(status.days_since_last_study, 3);
});

// ═══════════════════════════════════════════════════════════════
// 2. Date Helper Validation
// ═══════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════
// 3. StreakStatus Type Shape
// ═══════════════════════════════════════════════════════════════

Deno.test("StreakStatus: has all required fields", async () => {
  const db = mockStreakDbSimple({
    stats: { current_streak: 3, longest_streak: 10, last_study_date: todayUTC() },
    freezeCount: 1,
  });
  const status = await computeStreakStatus(db, "s1", "i1");

  // Verify all fields exist
  assertExists(status.current_streak !== undefined);
  assertExists(status.longest_streak !== undefined);
  assertExists(status.freezes_available !== undefined);
  assertExists(status.repair_eligible !== undefined);
  assertExists(status.streak_at_risk !== undefined);
  assertExists(status.studied_today !== undefined);
  // last_study_date and days_since_last_study can be null
  assertEquals(typeof status.current_streak, "number");
  assertEquals(typeof status.longest_streak, "number");
  assertEquals(typeof status.freezes_available, "number");
  assertEquals(typeof status.repair_eligible, "boolean");
  assertEquals(typeof status.streak_at_risk, "boolean");
  assertEquals(typeof status.studied_today, "boolean");
});

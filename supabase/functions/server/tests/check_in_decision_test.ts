/**
 * Standalone test for _computeCheckInDecision edge cases.
 *
 * This file focuses on tricky edge cases not covered in
 * streak_engine_test.ts to maximize coverage of the BUG-1 fix.
 *
 * Run: deno test supabase/functions/server/tests/check_in_decision_test.ts
 */

import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// ─── Environment Setup ───
Deno.env.set("SUPABASE_URL", "http://127.0.0.1:1");
Deno.env.set("SUPABASE_ANON_KEY", "fake-anon-key-for-testing");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "fake-service-role-key-for-testing");

const { _computeCheckInDecision } = await import("../streak-engine.ts");

// ═══════════════════════════════════════════════════════════════
// Edge Cases: Freeze consumption correctness
// ═══════════════════════════════════════════════════════════════

Deno.test("edge: 30-day gap with 29 freezes → consume all 29, streak maintained", () => {
  const freezeIds = Array.from({ length: 29 }, (_, i) => `f-${i}`);
  const d = _computeCheckInDecision(
    100, 100, "2026-02-11",
    freezeIds,
    "2026-03-13",
  );

  assertEquals(d.events[0].type, "freeze_consumed");
  assertEquals(d.freezeIdsToConsume.length, 29);
  assertEquals(d.newStreak, 101);
});

Deno.test("edge: 30-day gap with 28 freezes → break (need 29, have 28)", () => {
  const freezeIds = Array.from({ length: 28 }, (_, i) => `f-${i}`);
  const d = _computeCheckInDecision(
    100, 100, "2026-02-11",
    freezeIds,
    "2026-03-13",
  );

  assertEquals(d.events[0].type, "streak_broken");
  assertEquals(d.newStreak, 1);
  assertEquals((d.events[0].data as any).freezes_needed, 29);
});

Deno.test("edge: 2-day gap (need 1 freeze), has exactly 1 → consume, maintain", () => {
  const d = _computeCheckInDecision(
    5, 10, "2026-03-11",
    ["freeze-only"],
    "2026-03-13",
  );

  assertEquals(d.events[0].type, "freeze_consumed");
  assertEquals(d.freezeIdsToConsume, ["freeze-only"]);
  assertEquals(d.freezeUsedOnDates, ["2026-03-12"]);
  assertEquals(d.newStreak, 6);
});

Deno.test("edge: freeze used_on dates are chronologically correct", () => {
  // Gap: Mar 9 → Mar 13 = 4 days, need 3 freezes
  // Missed days: Mar 10, 11, 12
  const d = _computeCheckInDecision(
    10, 15, "2026-03-09",
    ["f1", "f2", "f3"],
    "2026-03-13",
  );

  // nDaysBefore("2026-03-13", 3) = ["2026-03-12", "2026-03-11", "2026-03-10"]
  assertEquals(d.freezeUsedOnDates[0], "2026-03-12");
  assertEquals(d.freezeUsedOnDates[1], "2026-03-11");
  assertEquals(d.freezeUsedOnDates[2], "2026-03-10");
});

Deno.test("edge: streak=0 with last_study_date → treat as broken, start new", () => {
  // Student has streak=0 but last study 2 days ago
  // This shouldn't happen normally, but defensively:
  const d = _computeCheckInDecision(
    0, 20, "2026-03-11",
    [],
    "2026-03-13",
  );

  // daysMissed=2, freezesNeeded=1, available=0 → streak_broken
  // But streak is already 0, so "broken" from 0 → newStreak = 1
  assertEquals(d.events[0].type, "streak_broken");
  assertEquals(d.newStreak, 1);
  assertEquals((d.events[0].data as any).lost_streak, 0);
});

Deno.test("edge: longest_streak updates when freeze-maintained streak exceeds it", () => {
  // Current: streak=20, longest=20
  // Miss 1 day, consume 1 freeze → streak becomes 21 → new longest
  const d = _computeCheckInDecision(
    20, 20, "2026-03-11",
    ["freeze-1"],
    "2026-03-13",
  );

  assertEquals(d.newStreak, 21);
  assertEquals(d.newLongest, 21); // ← updated
});

Deno.test("edge: invalid last_study_date → treat as new streak", () => {
  const d = _computeCheckInDecision(
    5, 10, "not-a-valid-date",
    [],
    "2026-03-13",
  );

  // daysBetween returns null for invalid dates → falls to Case 5
  assertEquals(d.events[0].type, "streak_started");
  assertEquals(d.newStreak, 1);
});

Deno.test("edge: freeze IDs order is preserved (oldest first consumed)", () => {
  const d = _computeCheckInDecision(
    5, 10, "2026-03-10",
    ["oldest", "middle", "newest"],
    "2026-03-13",
  );

  // daysMissed=3, need 2 freezes
  assertEquals(d.freezeIdsToConsume, ["oldest", "middle"]); // oldest first
});

Deno.test("edge: no events have undefined type", () => {
  const scenarios = [
    _computeCheckInDecision(5, 10, "2026-03-13", [], "2026-03-13"),
    _computeCheckInDecision(5, 10, "2026-03-12", [], "2026-03-13"),
    _computeCheckInDecision(5, 10, "2026-03-11", [], "2026-03-13"),
    _computeCheckInDecision(0, 0, null, [], "2026-03-13"),
    _computeCheckInDecision(5, 10, "2026-03-11", ["f1"], "2026-03-13"),
  ];

  for (const d of scenarios) {
    for (const e of d.events) {
      assertEquals(typeof e.type, "string");
      assertEquals(e.type.length > 0, true);
    }
  }
});

/**
 * tests/unit/streak-engine.test.ts — Unit tests for streak lifecycle management
 *
 * Tests the pure decision logic: _computeCheckInDecision, date helpers,
 * streak freeze consumption, and event generation.
 * Does NOT test async DB operations (performDailyCheckIn, computeStreakStatus).
 *
 * Run:
 *   deno test tests/unit/streak-engine.test.ts --no-check
 *
 * Coverage:
 * - todayUTC, yesterdayUTC, daysBetween: date calculations
 * - _computeCheckInDecision: all streak scenarios
 * - Freeze consumption: multi-day gaps, insufficient freezes
 * - Event types and messages (Spanish)
 */

import { assertEquals, assert, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  todayUTC,
  yesterdayUTC,
  daysBetween,
  _computeCheckInDecision,
  type CheckInDecision,
  type CheckInEvent,
} from "../../supabase/functions/server/streak-engine.ts";

// ─── Test Suite: Date Helpers ──────────────────────────────────────

Deno.test("streak-engine: todayUTC returns correct format YYYY-MM-DD", () => {
  const today = todayUTC();

  // Should match ISO format YYYY-MM-DD
  assert(/^\d{4}-\d{2}-\d{2}$/.test(today), `todayUTC should return YYYY-MM-DD format, got: ${today}`);

  // Should be a valid date
  const parsed = new Date(today + "T00:00:00Z");
  assert(!isNaN(parsed.getTime()), `todayUTC should return a valid date string`);
});

Deno.test("streak-engine: todayUTC matches Date.now in UTC", () => {
  const today = todayUTC();
  const now = new Date();
  const todayFromNow = now.toISOString().split("T")[0];

  assertEquals(today, todayFromNow, "todayUTC should match today's date in UTC");
});

Deno.test("streak-engine: yesterdayUTC returns previous day", () => {
  const yesterday = yesterdayUTC();
  const today = todayUTC();

  // yesterday should be 1 day before today
  const yesterdayDate = new Date(yesterday + "T00:00:00Z");
  const todayDate = new Date(today + "T00:00:00Z");
  const diffMs = todayDate.getTime() - yesterdayDate.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);

  assertEquals(diffDays, 1, "yesterday should be 1 day before today");
});

Deno.test("streak-engine: yesterdayUTC with known date", () => {
  // Set a specific known date and test daysBetween instead
  // (can't easily mock Date constructor in Deno test, so we test the concept)
  const exampleDate = "2026-04-02";
  const expectedYesterday = "2026-04-01";

  // Verify with daysBetween
  const days = daysBetween(expectedYesterday, exampleDate);
  assertEquals(days, 1, "2026-04-01 to 2026-04-02 = 1 day");
});

Deno.test("streak-engine: daysBetween with same day returns 0", () => {
  const sameDay = "2026-04-02";
  const days = daysBetween(sameDay, sameDay);

  assertEquals(days, 0, "Same day should return 0 days");
});

Deno.test("streak-engine: daysBetween with 1 day gap", () => {
  const dateA = "2026-04-01";
  const dateB = "2026-04-02";
  const days = daysBetween(dateA, dateB);

  assertEquals(days, 1, "2026-04-01 to 2026-04-02 = 1 day");
});

Deno.test("streak-engine: daysBetween with multiple day gap", () => {
  const dateA = "2026-04-01";
  const dateB = "2026-04-05";
  const days = daysBetween(dateA, dateB);

  assertEquals(days, 4, "2026-04-01 to 2026-04-05 = 4 days");
});

Deno.test("streak-engine: daysBetween with null dateA returns null", () => {
  const days = daysBetween(null, "2026-04-02");

  assertEquals(days, null, "daysBetween with null dateA should return null");
});

Deno.test("streak-engine: daysBetween with invalid date returns null", () => {
  const days = daysBetween("invalid-date", "2026-04-02");

  assertEquals(days, null, "daysBetween with invalid date should return null");
});

Deno.test("streak-engine: daysBetween with invalid dateB returns null", () => {
  const days = daysBetween("2026-04-01", "invalid-date");

  assertEquals(days, null, "daysBetween with invalid dateB should return null");
});

Deno.test("streak-engine: daysBetween negative gap (backward in time)", () => {
  const dateA = "2026-04-05";
  const dateB = "2026-04-01";
  const days = daysBetween(dateA, dateB);

  assertEquals(days, -4, "2026-04-05 to 2026-04-01 = -4 days");
});

// ─── Test Suite: _computeCheckInDecision ───────────────────────────

Deno.test("streak-engine: already checked in today → no streak change", () => {
  const today = "2026-04-02";
  const decision = _computeCheckInDecision(
    5, // currentStreak
    10, // longestStreak
    today, // lastStudyDate = today
    [], // availableFreezeIds
    today, // today
  );

  assertEquals(decision.newStreak, 5, "Streak should not change");
  assertEquals(decision.newLongest, 10, "Longest streak should not change");
  assertEquals(decision.events.length, 1, "Should have 1 event");
  assertEquals(decision.events[0].type, "already_checked_in");
  assert(decision.events[0].message.includes("racha esta segura"));
});

Deno.test("streak-engine: normal check-in (1 day gap) → streak increments", () => {
  const today = "2026-04-02";
  const yesterday = "2026-04-01";

  const decision = _computeCheckInDecision(
    5, // currentStreak
    5, // longestStreak
    yesterday, // lastStudyDate = yesterday
    [], // availableFreezeIds
    today, // today
  );

  assertEquals(decision.newStreak, 6, "Streak should increment by 1");
  assertEquals(decision.newLongest, 6, "New longest should update");
  assertEquals(decision.events.length, 1, "Should have 1 event");
  assertEquals(decision.events[0].type, "streak_incremented");
  assert(decision.events[0].message.includes("6 dias"));
  assertEquals(decision.events[0].data?.new_streak, 6);
});

Deno.test("streak-engine: check-in with longest streak update", () => {
  const today = "2026-04-02";
  const yesterday = "2026-04-01";

  const decision = _computeCheckInDecision(
    5, // currentStreak
    3, // longestStreak (lower than current!)
    yesterday, // lastStudyDate
    [], // no freezes
    today,
  );

  assertEquals(decision.newStreak, 6);
  assertEquals(decision.newLongest, 6, "Should update longest to new streak");
});

Deno.test("streak-engine: 2 missed days with 1 freeze → consume 1 freeze, streak continues", () => {
  const today = "2026-04-03";
  const twoDaysAgo = "2026-04-01";

  const decision = _computeCheckInDecision(
    5, // currentStreak
    10, // longestStreak
    twoDaysAgo, // lastStudyDate
    ["freeze-1"], // 1 available freeze
    today,
  );

  assertEquals(decision.newStreak, 6, "Streak should increment (freeze protected gap)");
  assertEquals(decision.newLongest, 10, "Longest doesn't increase if new < old");
  assertEquals(decision.events.length, 1, "Should have 1 event (freeze consumed)");
  assertEquals(decision.events[0].type, "freeze_consumed");
  assertEquals(decision.freezeIdsToConsume.length, 1, "Should consume 1 freeze");
  assertEquals(decision.freezeIdsToConsume[0], "freeze-1");
  assert(decision.events[0].message.includes("1 streak freeze"));
});

Deno.test("streak-engine: 3 missed days with 2 freezes → consume 2 freezes, streak continues", () => {
  const today = "2026-04-04";
  const threeDaysAgo = "2026-04-01";

  const decision = _computeCheckInDecision(
    7, // currentStreak
    15, // longestStreak
    threeDaysAgo, // lastStudyDate
    ["freeze-1", "freeze-2"], // 2 available freezes
    today,
  );

  assertEquals(decision.newStreak, 8, "Streak should increment");
  assertEquals(decision.freezeIdsToConsume.length, 2, "Should consume 2 freezes (for 2 missed days)");
  assertEquals(decision.events.length, 1);
  assertEquals(decision.events[0].type, "freeze_consumed");
  assert(decision.events[0].message.includes("2 streak freezes"));
  assertEquals(decision.events[0].data?.freezes_consumed, 2);
  assertEquals(decision.events[0].data?.freezes_remaining, 0);
});

Deno.test("streak-engine: 3 missed days with 1 freeze → insufficient, streak breaks", () => {
  const today = "2026-04-04";
  const threeDaysAgo = "2026-04-01";

  const decision = _computeCheckInDecision(
    10, // currentStreak
    20, // longestStreak
    threeDaysAgo, // lastStudyDate
    ["freeze-1"], // 1 available freeze (need 2)
    today,
  );

  assertEquals(decision.newStreak, 1, "Streak should reset to 1");
  assertEquals(decision.newLongest, 20, "Longest stays same");
  assertEquals(decision.freezeIdsToConsume.length, 0, "Should not consume any freezes");
  assertEquals(decision.events.length, 1);
  assertEquals(decision.events[0].type, "streak_broken");
  assert(decision.events[0].message.includes("10 dias se ha roto"));
  assertEquals(decision.events[0].data?.lost_streak, 10);
  assertEquals(decision.events[0].data?.days_missed, 3);
  assertEquals(decision.events[0].data?.freezes_available, 1);
  assertEquals(decision.events[0].data?.freezes_needed, 2);
});

Deno.test("streak-engine: 5 missed days with 0 freezes → streak broken", () => {
  const today = "2026-04-06";
  const fiveDaysAgo = "2026-04-01";

  const decision = _computeCheckInDecision(
    12, // currentStreak
    25, // longestStreak
    fiveDaysAgo, // lastStudyDate
    [], // no freezes
    today,
  );

  assertEquals(decision.newStreak, 1, "Streak resets to 1");
  assertEquals(decision.events.length, 1);
  assertEquals(decision.events[0].type, "streak_broken");
  assertEquals(decision.events[0].data?.days_missed, 5);
});

Deno.test("streak-engine: first ever check-in (null lastStudyDate) → streak starts at 1", () => {
  const today = "2026-04-02";

  const decision = _computeCheckInDecision(
    0, // currentStreak = 0
    0, // longestStreak = 0
    null, // lastStudyDate = null (first check-in ever)
    [], // no freezes
    today,
  );

  assertEquals(decision.newStreak, 1, "Streak starts at 1");
  assertEquals(decision.newLongest, 1, "Longest starts at 1");
  assertEquals(decision.events.length, 1);
  assertEquals(decision.events[0].type, "streak_started");
  assert(decision.events[0].message.includes("primera racha"));
  assertEquals(decision.events[0].data?.new_streak, 1);
});

Deno.test("streak-engine: new check-in after broken streak → streak_broken event", () => {
  const today = "2026-04-05";
  const farPast = "2026-03-20";

  const decision = _computeCheckInDecision(
    0, // currentStreak = 0 (was just broken)
    15, // longestStreak = 15 (preserved)
    farPast, // lastStudyDate is old — daysMissed >= 2 → streak_broken path
    [], // no freezes
    today,
  );

  assertEquals(decision.newStreak, 1, "New streak starts at 1");
  assertEquals(decision.newLongest, 15, "Longest preserved");
  // With lastStudyDate set and daysMissed >= 2 and no freezes, the code fires streak_broken
  assertEquals(decision.events[0].type, "streak_broken");
  assert(decision.events[0].message.includes("se ha roto"));
});

// ─── Test Suite: Freeze Consumption Details ────────────────────────

Deno.test("streak-engine: freeze IDs consumed match order", () => {
  const today = "2026-04-04";
  const threeDaysAgo = "2026-04-01";

  const decision = _computeCheckInDecision(
    5,
    10,
    threeDaysAgo,
    ["freeze-alpha", "freeze-beta", "freeze-gamma"],
    today,
  );

  // 3 - 1 = 2 freezes needed for 3 missed days
  assertEquals(decision.freezeIdsToConsume.length, 2);
  assertEquals(decision.freezeIdsToConsume[0], "freeze-alpha");
  assertEquals(decision.freezeIdsToConsume[1], "freeze-beta");
});

Deno.test("streak-engine: freeze used on dates generated correctly", () => {
  const today = "2026-04-04";
  const threeDaysAgo = "2026-04-01";

  const decision = _computeCheckInDecision(
    5,
    10,
    threeDaysAgo,
    ["freeze-1", "freeze-2"],
    today,
  );

  // Should have dates for 2 missed days: 2026-04-03, 2026-04-02
  assertEquals(decision.freezeUsedOnDates.length, 2);
  assert(
    decision.freezeUsedOnDates.includes("2026-04-03"),
    "Should include 2026-04-03",
  );
  assert(
    decision.freezeUsedOnDates.includes("2026-04-02"),
    "Should include 2026-04-02",
  );
});

Deno.test("streak-engine: freeze consumption with exactly needed freezes", () => {
  const today = "2026-04-04";
  const threeDaysAgo = "2026-04-01";

  // 3 - 1 = 2 freezes needed
  const decision = _computeCheckInDecision(
    8,
    8,
    threeDaysAgo,
    ["f1", "f2"], // exactly 2 available
    today,
  );

  assertEquals(decision.newStreak, 9, "Streak continues when freezes are sufficient");
  assertEquals(decision.freezeIdsToConsume.length, 2);
  assertEquals(decision.events[0].data?.freezes_remaining, 0);
});

Deno.test("streak-engine: freeze consumption with surplus freezes", () => {
  const today = "2026-04-04";
  const threeDaysAgo = "2026-04-01";

  // 3 - 1 = 2 freezes needed
  const decision = _computeCheckInDecision(
    8,
    8,
    threeDaysAgo,
    ["f1", "f2", "f3", "f4"], // 4 available (surplus)
    today,
  );

  assertEquals(decision.freezeIdsToConsume.length, 2);
  assertEquals(decision.events[0].data?.freezes_remaining, 2, "Should have 2 freezes left");
});

// ─── Test Suite: Edge Cases ────────────────────────────────────────

Deno.test("streak-engine: 2 missed days with exactly 1 freeze → streak continues", () => {
  // Edge case: 2 missed days = 1 freeze needed
  const today = "2026-04-03";
  const twoDaysAgo = "2026-04-01";

  const decision = _computeCheckInDecision(
    3,
    5,
    twoDaysAgo,
    ["freeze-only"],
    today,
  );

  assertEquals(decision.newStreak, 4, "Streak increments with 1 freeze for 2-day gap");
  assertEquals(decision.freezeIdsToConsume.length, 1);
});

Deno.test("streak-engine: 2 missed days with 0 freezes → streak broken", () => {
  const today = "2026-04-03";
  const twoDaysAgo = "2026-04-01";

  const decision = _computeCheckInDecision(
    3,
    5,
    twoDaysAgo,
    [], // no freezes
    today,
  );

  assertEquals(decision.newStreak, 1, "Streak broken with insufficient freezes");
  assertEquals(decision.events[0].type, "streak_broken");
});

Deno.test("streak-engine: current streak of 0 with no history → streak starts", () => {
  const today = "2026-04-02";

  const decision = _computeCheckInDecision(
    0, // current = 0
    0, // longest = 0
    null, // no history
    [],
    today,
  );

  assertEquals(decision.newStreak, 1);
  assertEquals(decision.newLongest, 1);
  assertEquals(decision.events[0].type, "streak_started");
});

Deno.test("streak-engine: zero streak with recent gap → new racha", () => {
  const today = "2026-04-02";
  const yesterday = "2026-04-01";

  // Current streak is 0 (just broken), but we have recent history
  const decision = _computeCheckInDecision(
    0, // currentStreak
    10, // longestStreak (preserved from before)
    yesterday, // lastStudyDate (yesterday)
    [],
    today,
  );

  // daysMissed = 1, so streak increments? No! currentStreak is 0.
  // The logic: if lastStudyDate && daysMissed === 1 → increment current.
  // Since currentStreak = 0, newStreak = 0 + 1 = 1
  assertEquals(decision.newStreak, 1);
  assertEquals(decision.newLongest, 10);
  assertEquals(decision.events[0].type, "streak_incremented");
});

// ─── Test Suite: Event Message Format ──────────────────────────────

Deno.test("streak-engine: already_checked_in event has correct structure", () => {
  const today = "2026-04-02";

  const decision = _computeCheckInDecision(
    3,
    3,
    today,
    [],
    today,
  );

  const event = decision.events[0];
  assertEquals(event.type, "already_checked_in");
  assert(typeof event.message === "string");
  assert(event.message.length > 0);
  // Event should not have data for this type
  assertEquals(event.data, undefined);
});

Deno.test("streak-engine: streak_incremented event includes data", () => {
  const today = "2026-04-02";
  const yesterday = "2026-04-01";

  const decision = _computeCheckInDecision(
    5,
    5,
    yesterday,
    [],
    today,
  );

  const event = decision.events[0];
  assertEquals(event.type, "streak_incremented");
  assertExists(event.data);
  assertEquals(event.data?.new_streak, 6);
});

Deno.test("streak-engine: freeze_consumed event includes comprehensive data", () => {
  const today = "2026-04-04";
  const threeDaysAgo = "2026-04-01";

  const decision = _computeCheckInDecision(
    5,
    10,
    threeDaysAgo,
    ["f1", "f2", "f3"],
    today,
  );

  const event = decision.events[0];
  assertEquals(event.type, "freeze_consumed");
  assertExists(event.data);
  assertEquals(event.data?.freezes_consumed, 2);
  assertEquals(event.data?.freezes_remaining, 1);
  assertEquals(event.data?.protected_streak, 5);
  assertEquals(event.data?.new_streak, 6);
  assertExists(event.data?.days_covered);
  assert(Array.isArray(event.data?.days_covered));
  assertEquals((event.data?.days_covered as string[]).length, 2);
});

Deno.test("streak-engine: streak_broken event includes data", () => {
  const today = "2026-04-04";
  const threeDaysAgo = "2026-04-01";

  const decision = _computeCheckInDecision(
    8,
    15,
    threeDaysAgo,
    [], // insufficient freezes
    today,
  );

  const event = decision.events[0];
  assertEquals(event.type, "streak_broken");
  assertExists(event.data);
  assertEquals(event.data?.lost_streak, 8);
  assertEquals(event.data?.days_missed, 3);
  assertEquals(event.data?.freezes_available, 0);
  assertEquals(event.data?.freezes_needed, 2);
});

Deno.test("streak-engine: streak_started event for new user", () => {
  const today = "2026-04-02";

  const decision = _computeCheckInDecision(
    0,
    0,
    null,
    [],
    today,
  );

  const event = decision.events[0];
  assertEquals(event.type, "streak_started");
  assertExists(event.data);
  assertEquals(event.data?.new_streak, 1);
  assert(event.message.includes("primera racha"));
});

Deno.test("streak-engine: freeze_consumed message singular vs plural", () => {
  // Test singular (1 freeze) — need daysMissed >= 2, freezesNeeded = daysMissed - 1 = 1
  const decision1 = _computeCheckInDecision(
    5,
    10,
    "2026-04-01", // 2 day gap → freezesNeeded = 1
    ["f1"],
    "2026-04-03",
  );

  const event1 = decision1.events[0];
  assertEquals(event1.type, "freeze_consumed");
  assert(event1.message.includes("1 streak freeze"), "Should say '1 streak freeze' (singular)");

  // Test plural (2+ freezes) — daysMissed = 3, freezesNeeded = 2
  const decision2 = _computeCheckInDecision(
    5,
    10,
    "2026-04-01",
    ["f1", "f2", "f3"],
    "2026-04-04",
  );

  const event2 = decision2.events[0];
  assertEquals(event2.type, "freeze_consumed");
  assert(event2.message.includes("2 streak freezes"), "Should say '2 streak freezes' (plural)");
});

// ─── Test Suite: Return Type Shape ────────────────────────────────

Deno.test("streak-engine: CheckInDecision always has required fields", () => {
  const today = "2026-04-02";

  const scenarios = [
    // Already checked in
    () =>
      _computeCheckInDecision(5, 10, today, [], today),
    // Normal increment
    () =>
      _computeCheckInDecision(5, 10, "2026-04-01", [], today),
    // Freeze consumed
    () =>
      _computeCheckInDecision(5, 10, "2026-04-01", ["f1", "f2"], today),
    // Streak broken
    () =>
      _computeCheckInDecision(5, 10, "2026-04-01", [], today),
    // First check-in
    () =>
      _computeCheckInDecision(0, 0, null, [], today),
  ];

  for (const scenario of scenarios) {
    const decision: CheckInDecision = scenario();

    // Required fields
    assert(
      typeof decision.newStreak === "number" && decision.newStreak >= 0,
      "newStreak should be a non-negative number",
    );
    assert(
      typeof decision.newLongest === "number" && decision.newLongest >= 0,
      "newLongest should be a non-negative number",
    );
    assert(Array.isArray(decision.events), "events should be an array");
    assert(Array.isArray(decision.freezeIdsToConsume), "freezeIdsToConsume should be an array");
    assert(Array.isArray(decision.freezeUsedOnDates), "freezeUsedOnDates should be an array");

    // Events should have required fields
    for (const event of decision.events) {
      assert(typeof event.type === "string", "event.type should be string");
      assert(typeof event.message === "string", "event.message should be string");
      // data is optional
    }
  }
});

// ─── Test Suite: Large Freeze Consumption ──────────────────────────

Deno.test("streak-engine: 10 missed days with 9 freezes → streak continues", () => {
  const today = "2026-04-11";
  const tenDaysAgo = "2026-04-01";

  // Generate 9 freezes
  const freezes = Array.from({ length: 9 }, (_, i) => `freeze-${i}`);

  const decision = _computeCheckInDecision(
    20,
    30,
    tenDaysAgo,
    freezes,
    today,
  );

  // 10 - 1 = 9 freezes needed
  assertEquals(decision.newStreak, 21, "Streak increments with sufficient freezes");
  assertEquals(decision.freezeIdsToConsume.length, 9);
  assertEquals(decision.events[0].type, "freeze_consumed");
  assertEquals(decision.events[0].data?.freezes_consumed, 9);
});

Deno.test("streak-engine: 10 missed days with 8 freezes → streak broken", () => {
  const today = "2026-04-11";
  const tenDaysAgo = "2026-04-01";

  const freezes = Array.from({ length: 8 }, (_, i) => `freeze-${i}`);

  const decision = _computeCheckInDecision(
    20,
    30,
    tenDaysAgo,
    freezes,
    today,
  );

  // 10 - 1 = 9 freezes needed, only 8 available
  assertEquals(decision.newStreak, 1, "Streak breaks with insufficient freezes");
  assertEquals(decision.freezeIdsToConsume.length, 0);
  assertEquals(decision.events[0].type, "streak_broken");
  assertEquals(decision.events[0].data?.days_missed, 10);
  assertEquals(decision.events[0].data?.freezes_needed, 9);
});

// ─── Test Suite: Longest Streak Updates ────────────────────────────

Deno.test("streak-engine: new streak exceeds longest → longest updates", () => {
  const today = "2026-04-02";
  const yesterday = "2026-04-01";

  const decision = _computeCheckInDecision(
    9, // current
    9, // longest
    yesterday,
    [],
    today,
  );

  assertEquals(decision.newStreak, 10);
  assertEquals(decision.newLongest, 10, "Longest should update to 10");
});

Deno.test("streak-engine: new streak below longest → longest unchanged", () => {
  const today = "2026-04-02";
  const yesterday = "2026-04-01";

  const decision = _computeCheckInDecision(
    5, // current
    20, // longest (much higher)
    yesterday,
    [],
    today,
  );

  assertEquals(decision.newStreak, 6);
  assertEquals(decision.newLongest, 20, "Longest should remain 20");
});

Deno.test("streak-engine: freeze protected streak exceeds longest → longest updates", () => {
  const today = "2026-04-03";
  const twoDaysAgo = "2026-04-01";

  const decision = _computeCheckInDecision(
    14, // current
    14, // longest
    twoDaysAgo,
    ["f1"],
    today,
  );

  // Streak increments to 15 with freeze
  assertEquals(decision.newStreak, 15);
  assertEquals(decision.newLongest, 15, "Longest updates with freeze-protected increment");
});

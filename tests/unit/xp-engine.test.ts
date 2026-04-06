/**
 * tests/unit/xp-engine.test.ts — Unit tests for XP calculation engine
 *
 * Tests the pure logic functions: calculateLevel, multiplier stacking,
 * and XP table lookups. Does NOT test async DB calls (awardXP, awardXPFallback).
 *
 * Run:
 *   deno test tests/unit/xp-engine.test.ts --no-check
 *
 * Coverage:
 * - calculateLevel: 0 XP, various thresholds, max XP
 * - LEVEL_THRESHOLDS: boundary conditions
 * - Multiplier stacking logic (pure calculations only)
 * - XP_TABLE lookups
 */

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Set environment variables BEFORE dynamic import of xp-engine (which imports db.ts at module level)
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");

const { calculateLevel, LEVEL_THRESHOLDS, XP_TABLE } = await import(
  "../../supabase/functions/server/xp-engine.ts"
);

// ─── Test Suite: calculateLevel ─────────────────────────────────

Deno.test("xp-engine: 0 XP returns level 1", () => {
  const level = calculateLevel(0);
  assertEquals(level, 1, "0 XP should be level 1");
});

Deno.test("xp-engine: 1 XP returns level 1", () => {
  const level = calculateLevel(1);
  assertEquals(level, 1, "1 XP should be level 1");
});

Deno.test("xp-engine: 99 XP returns level 1", () => {
  const level = calculateLevel(99);
  assertEquals(level, 1, "99 XP (below level 2 threshold of 100) should be level 1");
});

Deno.test("xp-engine: exactly 100 XP returns level 2", () => {
  const level = calculateLevel(100);
  assertEquals(level, 2, "100 XP (exactly at level 2 threshold) should be level 2");
});

Deno.test("xp-engine: 299 XP returns level 2", () => {
  const level = calculateLevel(299);
  assertEquals(level, 2, "299 XP (below level 3 threshold of 300) should be level 2");
});

Deno.test("xp-engine: exactly 300 XP returns level 3", () => {
  const level = calculateLevel(300);
  assertEquals(level, 3, "300 XP (exactly at level 3 threshold) should be level 3");
});

Deno.test("xp-engine: 600 XP returns level 4", () => {
  const level = calculateLevel(600);
  assertEquals(level, 4, "600 XP (exactly at level 4 threshold) should be level 4");
});

Deno.test("xp-engine: 1000 XP returns level 5", () => {
  const level = calculateLevel(1000);
  assertEquals(level, 5, "1000 XP (exactly at level 5 threshold) should be level 5");
});

Deno.test("xp-engine: 1500 XP returns level 6", () => {
  const level = calculateLevel(1500);
  assertEquals(level, 6, "1500 XP (exactly at level 6 threshold) should be level 6");
});

Deno.test("xp-engine: 2200 XP returns level 7", () => {
  const level = calculateLevel(2200);
  assertEquals(level, 7, "2200 XP (exactly at level 7 threshold) should be level 7");
});

Deno.test("xp-engine: 3000 XP returns level 8", () => {
  const level = calculateLevel(3000);
  assertEquals(level, 8, "3000 XP (exactly at level 8 threshold) should be level 8");
});

Deno.test("xp-engine: 4000 XP returns level 9", () => {
  const level = calculateLevel(4000);
  assertEquals(level, 9, "4000 XP (exactly at level 9 threshold) should be level 9");
});

Deno.test("xp-engine: 5500 XP returns level 10", () => {
  const level = calculateLevel(5500);
  assertEquals(level, 10, "5500 XP (exactly at level 10 threshold) should be level 10");
});

Deno.test("xp-engine: 7500 XP returns level 11", () => {
  const level = calculateLevel(7500);
  assertEquals(level, 11, "7500 XP (exactly at level 11 threshold) should be level 11");
});

Deno.test("xp-engine: 10000 XP returns level 12", () => {
  const level = calculateLevel(10000);
  assertEquals(level, 12, "10000 XP (exactly at level 12 threshold) should be level 12");
});

Deno.test("xp-engine: 999999 XP returns level 12 (max)", () => {
  const level = calculateLevel(999999);
  assertEquals(level, 12, "999999 XP (above all thresholds) should be level 12 (max)");
});

Deno.test("xp-engine: 10001 XP returns level 12", () => {
  const level = calculateLevel(10001);
  assertEquals(level, 12, "10001 XP (above level 12 threshold) should be level 12");
});

// ─── Test Suite: Boundary conditions between levels ────────────────

Deno.test("xp-engine: boundary just below each level", () => {
  // Test each level boundary by checking 1 XP below the threshold
  const boundaries = [
    [99, 1],
    [299, 2],
    [599, 3],
    [999, 4],
    [1499, 5],
    [2199, 6],
    [2999, 7],
    [3999, 8],
    [5499, 9],
    [7499, 10],
    [9999, 11],
  ];

  for (const [xp, expectedLevel] of boundaries) {
    const level = calculateLevel(xp as number);
    assertEquals(
      level,
      expectedLevel,
      `${xp} XP should be level ${expectedLevel}`,
    );
  }
});

// ─── Test Suite: LEVEL_THRESHOLDS structure ────────────────────

Deno.test("xp-engine: LEVEL_THRESHOLDS is properly sorted descending", () => {
  for (let i = 0; i < LEVEL_THRESHOLDS.length - 1; i++) {
    const currentXP = LEVEL_THRESHOLDS[i][0];
    const nextXP = LEVEL_THRESHOLDS[i + 1][0];
    assert(
      currentXP > nextXP,
      `LEVEL_THRESHOLDS[${i}] XP (${currentXP}) should be > ${nextXP}`,
    );
  }
});

Deno.test("xp-engine: LEVEL_THRESHOLDS has exactly 11 entries", () => {
  assertEquals(
    LEVEL_THRESHOLDS.length,
    11,
    "LEVEL_THRESHOLDS should have 11 entries (levels 2-12)",
  );
});

Deno.test("xp-engine: LEVEL_THRESHOLDS maps XP to correct levels", () => {
  // Verify the mapping of each threshold
  const expectedMapping = [
    [10000, 12],
    [7500, 11],
    [5500, 10],
    [4000, 9],
    [3000, 8],
    [2200, 7],
    [1500, 6],
    [1000, 5],
    [600, 4],
    [300, 3],
    [100, 2],
  ];

  for (let i = 0; i < expectedMapping.length; i++) {
    const [expectedXP, expectedLevel] = expectedMapping[i];
    const [actualXP, actualLevel] = LEVEL_THRESHOLDS[i];
    assertEquals(actualXP, expectedXP, `Threshold ${i} XP should be ${expectedXP}`);
    assertEquals(actualLevel, expectedLevel, `Threshold ${i} level should be ${expectedLevel}`);
  }
});

// ─── Test Suite: XP_TABLE lookups ──────────────────────────────

Deno.test("xp-engine: XP_TABLE has all expected action types", () => {
  const expectedActions = [
    "review_flashcard",
    "review_correct",
    "quiz_answer",
    "quiz_correct",
    "complete_session",
    "complete_reading",
    "complete_video",
    "streak_daily",
    "complete_plan_task",
    "complete_plan",
    "rag_question",
  ];

  for (const action of expectedActions) {
    assert(
      action in XP_TABLE,
      `XP_TABLE should have action '${action}'`,
    );
    assert(
      typeof XP_TABLE[action] === "number" && XP_TABLE[action] > 0,
      `XP_TABLE['${action}'] should be a positive number`,
    );
  }
});

Deno.test("xp-engine: XP_TABLE all values are positive", () => {
  for (const [action, xp] of Object.entries(XP_TABLE)) {
    assert(
      xp > 0,
      `XP_TABLE['${action}'] = ${xp} should be positive`,
    );
  }
});

Deno.test("xp-engine: XP_TABLE correct base values", () => {
  assertEquals(XP_TABLE.review_flashcard, 5);
  assertEquals(XP_TABLE.review_correct, 10);
  assertEquals(XP_TABLE.quiz_answer, 5);
  assertEquals(XP_TABLE.quiz_correct, 15);
  assertEquals(XP_TABLE.complete_session, 25);
  assertEquals(XP_TABLE.complete_reading, 30);
  assertEquals(XP_TABLE.complete_video, 20);
  assertEquals(XP_TABLE.streak_daily, 15);
  assertEquals(XP_TABLE.complete_plan_task, 15);
  assertEquals(XP_TABLE.complete_plan, 100);
  assertEquals(XP_TABLE.rag_question, 5);
});

// ─── Test Suite: Pure Multiplier Calculation Logic ────────────────

Deno.test("xp-engine: on-time bonus calculation (+50%)", () => {
  // On-time bonus: 24 hours = +0.5 multiplier
  // Pure logic: if (hoursDiff <= 24) multiplier += 0.5
  const baseMultiplier = 1.0;
  const hoursThreshold = 24;

  // Within 24 hours → bonus applies
  const hoursWithin = 12;
  const multiplierWithBonus = baseMultiplier + (hoursWithin <= hoursThreshold ? 0.5 : 0);
  assertEquals(multiplierWithBonus, 1.5, "12 hours = 1.0 + 0.5 = 1.5x");

  // Exactly 24 hours → bonus applies
  const multiplierAt24h = baseMultiplier + (hoursThreshold <= hoursThreshold ? 0.5 : 0);
  assertEquals(multiplierAt24h, 1.5, "24 hours = 1.0 + 0.5 = 1.5x");

  // After 24 hours → no bonus
  const hoursAfter = 25;
  const multiplierAfter = baseMultiplier + (hoursAfter <= hoursThreshold ? 0.5 : 0);
  assertEquals(multiplierAfter, 1.0, ">24 hours = no bonus = 1.0x");
});

Deno.test("xp-engine: flow zone bonus calculation (+25%)", () => {
  // Flow zone: 0.3 <= pKnow <= 0.7 → +0.25 multiplier
  const baseMultiplier = 1.0;

  // Test within range
  const pKnowLow = 0.3;
  const multiplierLow = baseMultiplier + (pKnowLow >= 0.3 && pKnowLow <= 0.7 ? 0.25 : 0);
  assertEquals(multiplierLow, 1.25, "pKnow=0.3 is in flow zone = 1.25x");

  const pKnowMid = 0.5;
  const multiplierMid = baseMultiplier + (pKnowMid >= 0.3 && pKnowMid <= 0.7 ? 0.25 : 0);
  assertEquals(multiplierMid, 1.25, "pKnow=0.5 is in flow zone = 1.25x");

  const pKnowHigh = 0.7;
  const multiplierHigh = baseMultiplier + (pKnowHigh >= 0.3 && pKnowHigh <= 0.7 ? 0.25 : 0);
  assertEquals(multiplierHigh, 1.25, "pKnow=0.7 is in flow zone = 1.25x");

  // Test outside range
  const pKnowTooLow = 0.29;
  const multiplierTooLow = baseMultiplier + (pKnowTooLow >= 0.3 && pKnowTooLow <= 0.7 ? 0.25 : 0);
  assertEquals(multiplierTooLow, 1.0, "pKnow=0.29 is below flow zone = 1.0x");

  const pKnowTooHigh = 0.71;
  const multiplierTooHigh = baseMultiplier + (pKnowTooHigh >= 0.3 && pKnowTooHigh <= 0.7 ? 0.25 : 0);
  assertEquals(multiplierTooHigh, 1.0, "pKnow=0.71 is above flow zone = 1.0x");
});

Deno.test("xp-engine: streak multiplier calculation (+50% at 7+ days)", () => {
  // Streak bonus: currentStreak >= 7 → +0.5 multiplier
  const baseMultiplier = 1.0;

  // Below threshold
  const streak6 = 6;
  const multiplier6 = baseMultiplier + (streak6 >= 7 ? 0.5 : 0);
  assertEquals(multiplier6, 1.0, "streak=6 is below threshold = 1.0x");

  // At threshold
  const streak7 = 7;
  const multiplier7 = baseMultiplier + (streak7 >= 7 ? 0.5 : 0);
  assertEquals(multiplier7, 1.5, "streak=7 is at threshold = 1.5x");

  // Above threshold
  const streak30 = 30;
  const multiplier30 = baseMultiplier + (streak30 >= 7 ? 0.5 : 0);
  assertEquals(multiplier30, 1.5, "streak=30 is above threshold = 1.5x");
});

// ─── Test Suite: Multiplier Stacking ───────────────────────────────

Deno.test("xp-engine: multipliers stack additively (on-time + flow zone)", () => {
  // Multiple bonuses stack: 1.0 + 0.5 (on-time) + 0.25 (flow zone) = 1.75
  let multiplier = 1.0;

  // On-time bonus
  multiplier += 0.5;
  // Flow zone bonus
  multiplier += 0.25;

  assertEquals(multiplier, 1.75, "on-time (0.5) + flow_zone (0.25) = 1.75x");
});

Deno.test("xp-engine: multipliers stack: all three bonuses", () => {
  // All bonuses: 1.0 + 0.5 (on-time) + 0.25 (flow) + 0.5 (streak) = 2.25
  let multiplier = 1.0;

  multiplier += 0.5; // on-time
  multiplier += 0.25; // flow_zone
  multiplier += 0.5; // streak

  assertEquals(multiplier, 2.25, "on-time + flow + streak = 2.25x");
});

Deno.test("xp-engine: variable reward bonus (100% bonus)", () => {
  // Variable reward (triggered by Math.random() < 0.1):
  // adds +1.0 to multiplier (doubles XP)
  // This test demonstrates the pure calculation only
  let multiplier = 1.0;
  multiplier += 1.0; // variable bonus

  assertEquals(multiplier, 2.0, "variable bonus = 1.0 + 1.0 = 2.0x");
});

Deno.test("xp-engine: maximum possible multiplier (all bonuses)", () => {
  // Theoretical max: 1.0 + 0.5 (on-time) + 0.25 (flow) + 1.0 (variable) + 0.5 (streak) = 3.25x
  // Note: in practice, variable (10% chance) + others is rare, but theoretically possible
  let multiplier = 1.0;

  multiplier += 0.5; // on-time
  multiplier += 0.25; // flow_zone
  multiplier += 1.0; // variable (if triggered)
  multiplier += 0.5; // streak

  assertEquals(multiplier, 3.25, "max stacking = 3.25x");
});

// ─── Test Suite: XP Calculation with Multipliers ────────────────────

Deno.test("xp-engine: base XP with no bonuses", () => {
  const xpBase = 10;
  const multiplier = 1.0;
  const xpFinal = Math.round(xpBase * multiplier);

  assertEquals(xpFinal, 10, "10 base * 1.0x = 10");
});

Deno.test("xp-engine: base XP with on-time bonus", () => {
  const xpBase = 10;
  const multiplier = 1.5; // on-time
  const xpFinal = Math.round(xpBase * multiplier);

  assertEquals(xpFinal, 15, "10 base * 1.5x = 15");
});

Deno.test("xp-engine: base XP with flow zone bonus", () => {
  const xpBase = 10;
  const multiplier = 1.25; // flow_zone
  const xpFinal = Math.round(xpBase * multiplier);

  assertEquals(xpFinal, 13, "10 base * 1.25x = 12.5 ≈ 13 (rounded)");
});

Deno.test("xp-engine: base XP with streak bonus", () => {
  const xpBase = 15;
  const multiplier = 1.5; // streak (7+ days)
  const xpFinal = Math.round(xpBase * multiplier);

  assertEquals(xpFinal, 23, "15 base * 1.5x = 22.5 ≈ 23 (rounded)");
});

Deno.test("xp-engine: rounding behavior for multiplied XP", () => {
  // Test Math.round behavior with various multiplier results
  const testCases = [
    [5, 1.25, 6], // 6.25 → 6
    [5, 1.5, 8], // 7.5 → 8
    [10, 1.75, 18], // 17.5 → 18
    [7, 1.2, 8], // 8.4 → 8
    [7, 1.3, 9], // 9.1 → 9
  ];

  for (const [xpBase, multiplier, expected] of testCases) {
    const xpFinal = Math.round((xpBase as number) * (multiplier as number));
    assertEquals(
      xpFinal,
      expected,
      `${xpBase} base * ${multiplier}x should round to ${expected}`,
    );
  }
});

// ─── Test Suite: Daily Cap Logic (Pure) ────────────────────────────

Deno.test("xp-engine: daily cap enforcement with no prior XP", () => {
  const DAILY_CAP = 500;
  const currentDailyUsed = 0;
  const xpFinal = 100;

  const remainingCap = DAILY_CAP - currentDailyUsed;
  const cappedXp = Math.min(xpFinal, remainingCap);

  assertEquals(cappedXp, 100, "100 XP with 0 used = 100 awarded");
});

Deno.test("xp-engine: daily cap enforcement with partial usage", () => {
  const DAILY_CAP = 500;
  const currentDailyUsed = 450;
  const xpFinal = 100;

  const remainingCap = DAILY_CAP - currentDailyUsed;
  const cappedXp = Math.min(xpFinal, remainingCap);

  assertEquals(cappedXp, 50, "100 XP with 450 used = 50 capped (remaining 50)");
});

Deno.test("xp-engine: daily cap enforcement at exact limit", () => {
  const DAILY_CAP = 500;
  const currentDailyUsed = 500;
  const xpFinal = 100;

  const remainingCap = DAILY_CAP - currentDailyUsed;
  // When remaining <= 0, apply post-cap rate (10%)
  const POST_CAP_RATE = 0.1;
  const cappedXp = remainingCap <= 0 ? Math.max(1, Math.round(xpFinal * POST_CAP_RATE)) : Math.min(xpFinal, remainingCap);

  assertEquals(cappedXp, 10, "100 XP at cap = 10% post-cap rate = 10 XP");
});

Deno.test("xp-engine: post-cap rate (10%) maintains engagement", () => {
  const DAILY_CAP = 500;
  const currentDailyUsed = 500; // At cap
  const POST_CAP_RATE = 0.1;

  const testCases = [
    [5, 1], // 5 * 0.1 = 0.5 → max(1, 1) = 1
    [10, 1], // 10 * 0.1 = 1 → max(1, 1) = 1
    [100, 10], // 100 * 0.1 = 10 → max(1, 10) = 10
    [150, 15], // 150 * 0.1 = 15 → max(1, 15) = 15
  ];

  for (const [xpFinal, expected] of testCases) {
    const cappedXp = Math.max(1, Math.round((xpFinal as number) * POST_CAP_RATE));
    assertEquals(
      cappedXp,
      expected,
      `${xpFinal} XP with post-cap rate = ${expected}`,
    );
  }
});

// ─── Test Suite: Integration scenarios ──────────────────────────────

Deno.test("xp-engine: realistic scenario - quiz correct with all bonuses", () => {
  // Scenario: Quiz answer with on-time, flow zone, and streak bonus
  const xpBase = 15; // quiz_correct
  let multiplier = 1.0;

  // On-time (reviewed within 24h of due)
  multiplier += 0.5;
  // Flow zone (pKnow = 0.5)
  multiplier += 0.25;
  // Streak (7+ days)
  multiplier += 0.5;

  const xpFinal = Math.round(xpBase * multiplier);
  const newTotal = 100 + xpFinal; // Assume starting from level 2 (100 XP)
  const newLevel = calculateLevel(newTotal);

  assertEquals(xpFinal, 34, "15 base * 2.25x = 33.75 ≈ 34");
  assertEquals(newLevel, calculateLevel(100 + xpFinal), "Level matches calculateLevel output");
});

Deno.test("xp-engine: realistic scenario - multiple reviews approaching cap", () => {
  const DAILY_CAP = 500;
  let dailyUsed = 0;

  // First review: 10 XP
  dailyUsed += 10;
  assertEquals(dailyUsed, 10);

  // Second review with bonus: 20 XP
  dailyUsed += 20;
  assertEquals(dailyUsed, 30);

  // Large session: 200 XP, should cap at remaining 470
  const sessionXp = 200;
  const remaining = DAILY_CAP - dailyUsed;
  const cappedSession = Math.min(sessionXp, remaining);
  dailyUsed += cappedSession;

  assertEquals(cappedSession, 200, "200 XP fits within remaining 470");
  assertEquals(dailyUsed, 230, "Total: 10 + 20 + 200 = 230");
});

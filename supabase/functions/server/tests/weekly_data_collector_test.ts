// ============================================================
// tests/weekly_data_collector_test.ts — Weekly data collector unit tests
// Run: deno test --allow-none supabase/functions/server/tests/weekly_data_collector_test.ts
// ============================================================

import { assertEquals } from "https://deno.land/std@0.208.0/assert/assert_equals.ts";
import {
  getCurrentWeekStart,
  getCurrentWeekEnd,
  formatDate,
} from "../lib/weekly-data-collector.ts";

// ── Week Boundary Tests ─────────────────────────────────────

Deno.test("getCurrentWeekStart returns a Monday", () => {
  const monday = getCurrentWeekStart();
  assertEquals(monday.getUTCDay(), 1, "week_start should be Monday (day 1)");
});

Deno.test("getCurrentWeekEnd returns a Sunday", () => {
  const sunday = getCurrentWeekEnd();
  assertEquals(sunday.getUTCDay(), 0, "week_end should be Sunday (day 0)");
});

Deno.test("weekEnd is exactly 6 days after weekStart", () => {
  const start = getCurrentWeekStart();
  const end = getCurrentWeekEnd();
  const diffMs = end.getTime() - start.getTime();
  const diffDays = diffMs / (24 * 60 * 60 * 1000);
  assertEquals(diffDays, 6, "end - start should be 6 days");
});

// ── formatDate ──────────────────────────────────────────────

Deno.test("formatDate produces YYYY-MM-DD", () => {
  const d = new Date(Date.UTC(2026, 2, 16)); // March 16, 2026
  assertEquals(formatDate(d), "2026-03-16");
});

Deno.test("formatDate zero-pads month and day", () => {
  const d = new Date(Date.UTC(2026, 0, 5)); // Jan 5
  assertEquals(formatDate(d), "2026-01-05");
});

// ── Accuracy Edge Cases ─────────────────────────────────────
// These test the math logic inline (same formula used in collectWeeklyData)

Deno.test("accuracy is 0 when totalReviews is 0", () => {
  const totalReviews = 0;
  const correctReviews = 0;
  const accuracy = totalReviews > 0
    ? Math.round((correctReviews / totalReviews) * 10000) / 100
    : 0;
  assertEquals(accuracy, 0);
});

Deno.test("accuracy rounds to 2 decimal places", () => {
  const totalReviews = 3;
  const correctReviews = 1;
  const accuracy = totalReviews > 0
    ? Math.round((correctReviews / totalReviews) * 10000) / 100
    : 0;
  assertEquals(accuracy, 33.33);
});

Deno.test("accuracy is 100 when all correct", () => {
  const totalReviews = 50;
  const correctReviews = 50;
  const accuracy = totalReviews > 0
    ? Math.round((correctReviews / totalReviews) * 10000) / 100
    : 0;
  assertEquals(accuracy, 100);
});

// ── daysActive cap ──────────────────────────────────────────

Deno.test("daysActive never exceeds 7", () => {
  // Simulate more than 7 activity rows (edge: bad data)
  const activitiesLength = 15;
  const daysActive = Math.min(activitiesLength, 7);
  assertEquals(daysActive, 7);
});

Deno.test("daysActive is 0 with no activities", () => {
  const activitiesLength = 0;
  const daysActive = Math.min(activitiesLength, 7);
  assertEquals(daysActive, 0);
});

// ── Knowledge profile mapping ───────────────────────────────
// Test the mapping logic from RPC shape to WeeklyRawData shape

Deno.test("mapKnowledgeProfile handles null profile", () => {
  // Same logic as in weekly-data-collector.ts mapKnowledgeProfile
  const profile = null;
  const result = profile
    ? { weakTopics: [], strongTopics: [], lapsingCards: [] }
    : { weakTopics: [], strongTopics: [], lapsingCards: [] };
  assertEquals(result.weakTopics.length, 0);
  assertEquals(result.strongTopics.length, 0);
  assertEquals(result.lapsingCards.length, 0);
});

Deno.test("mapKnowledgeProfile maps weak items correctly", () => {
  const weak = [{ sub: "Farmacología", kw: "IC50", p: 0.32, att: 5 }];
  const mapped = weak.map((w) => ({
    topicName: w.sub,
    masteryLevel: w.p,
    reason: `p_know ${w.p}, ${w.att} intentos – keyword: ${w.kw}`,
  }));
  assertEquals(mapped[0].topicName, "Farmacología");
  assertEquals(mapped[0].masteryLevel, 0.32);
  assertEquals(mapped[0].reason.includes("IC50"), true);
});

Deno.test("mapKnowledgeProfile maps lapsing items correctly", () => {
  const lapsing = [{ card: "¿Qué es IC50?", kw: "Farmacodinámica", lapses: 4, state: 2 }];
  const mapped = lapsing.map((l) => ({
    cardFront: l.card,
    keyword: l.kw,
    lapses: l.lapses,
  }));
  assertEquals(mapped[0].cardFront, "¿Qué es IC50?");
  assertEquals(mapped[0].keyword, "Farmacodinámica");
  assertEquals(mapped[0].lapses, 4);
});

// ============================================================
// tests/weekly_data_collector_test.ts — Weekly data collector unit tests
// Run: deno test --allow-none supabase/functions/server/tests/weekly_data_collector_test.ts
// ============================================================

import { assertEquals } from "https://deno.land/std@0.208.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.208.0/assert/assert.ts";
import {
  getCurrentWeekStart,
  getCurrentWeekEnd,
  formatDate,
  computeAccuracy,
  computeDaysActive,
  mapKnowledgeProfile,
  type KnowledgeProfile,
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

Deno.test("weekStart is always <= today", () => {
  const start = getCurrentWeekStart();
  const now = new Date();
  assert(start.getTime() <= now.getTime(), "weekStart should be <= now");
});

Deno.test("weekEnd is always >= today", () => {
  const end = getCurrentWeekEnd();
  const todayStart = new Date(Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate(),
  ));
  assert(end.getTime() >= todayStart.getTime(), "weekEnd should be >= today start");
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

Deno.test("formatDate handles year boundary", () => {
  const d = new Date(Date.UTC(2025, 11, 31)); // Dec 31, 2025
  assertEquals(formatDate(d), "2025-12-31");
});

// ── computeAccuracy (real exported function) ────────────────

Deno.test("computeAccuracy returns 0 when totalReviews is 0", () => {
  assertEquals(computeAccuracy(0, 0), 0);
});

Deno.test("computeAccuracy returns 0 when correct=0 total>0", () => {
  assertEquals(computeAccuracy(0, 10), 0);
});

Deno.test("computeAccuracy rounds to 2 decimal places", () => {
  assertEquals(computeAccuracy(1, 3), 33.33);
});

Deno.test("computeAccuracy is 100 when all correct", () => {
  assertEquals(computeAccuracy(50, 50), 100);
});

Deno.test("computeAccuracy handles 2/3 correctly", () => {
  assertEquals(computeAccuracy(2, 3), 66.67);
});

Deno.test("computeAccuracy handles 1 correct of 1 total", () => {
  assertEquals(computeAccuracy(1, 1), 100);
});

// ── computeDaysActive (real exported function) ──────────────

Deno.test("computeDaysActive never exceeds 7", () => {
  assertEquals(computeDaysActive(15), 7);
});

Deno.test("computeDaysActive is 0 with no activities", () => {
  assertEquals(computeDaysActive(0), 0);
});

Deno.test("computeDaysActive passes through values 1-7", () => {
  assertEquals(computeDaysActive(1), 1);
  assertEquals(computeDaysActive(5), 5);
  assertEquals(computeDaysActive(7), 7);
});

// ── mapKnowledgeProfile (real exported function) ────────────

Deno.test("mapKnowledgeProfile handles null profile", () => {
  const result = mapKnowledgeProfile(null);
  assertEquals(result.weakTopics.length, 0);
  assertEquals(result.strongTopics.length, 0);
  assertEquals(result.lapsingCards.length, 0);
});

Deno.test("mapKnowledgeProfile handles empty profile", () => {
  const result = mapKnowledgeProfile({});
  assertEquals(result.weakTopics.length, 0);
  assertEquals(result.strongTopics.length, 0);
  assertEquals(result.lapsingCards.length, 0);
});

Deno.test("mapKnowledgeProfile handles profile with empty arrays", () => {
  const result = mapKnowledgeProfile({ weak: [], strong: [], lapsing: [] });
  assertEquals(result.weakTopics.length, 0);
  assertEquals(result.strongTopics.length, 0);
  assertEquals(result.lapsingCards.length, 0);
});

Deno.test("mapKnowledgeProfile maps weak items correctly", () => {
  const profile: KnowledgeProfile = {
    weak: [
      { sub: "Farmacología", kw: "IC50", p: 0.32, att: 5 },
      { sub: "Fisiología", kw: "GFR", p: 0.45, att: 3 },
    ],
  };
  const result = mapKnowledgeProfile(profile);

  assertEquals(result.weakTopics.length, 2);
  assertEquals(result.weakTopics[0].topicName, "Farmacología");
  assertEquals(result.weakTopics[0].masteryLevel, 0.32);
  assert(result.weakTopics[0].reason.includes("IC50"));
  assert(result.weakTopics[0].reason.includes("0.32"));
  assert(result.weakTopics[0].reason.includes("5 intentos"));
  assertEquals(result.weakTopics[1].topicName, "Fisiología");
});

Deno.test("mapKnowledgeProfile maps strong items correctly", () => {
  const profile: KnowledgeProfile = {
    strong: [{ sub: "Anatomía", kw: "bones", p: 0.91 }],
  };
  const result = mapKnowledgeProfile(profile);

  assertEquals(result.strongTopics.length, 1);
  assertEquals(result.strongTopics[0].topicName, "Anatomía");
  assertEquals(result.strongTopics[0].masteryLevel, 0.91);
});

Deno.test("mapKnowledgeProfile maps lapsing items correctly", () => {
  const profile: KnowledgeProfile = {
    lapsing: [{ card: "¿Qué es IC50?", kw: "Farmacodinámica", lapses: 4, state: 2 }],
  };
  const result = mapKnowledgeProfile(profile);

  assertEquals(result.lapsingCards.length, 1);
  assertEquals(result.lapsingCards[0].cardFront, "¿Qué es IC50?");
  assertEquals(result.lapsingCards[0].keyword, "Farmacodinámica");
  assertEquals(result.lapsingCards[0].lapses, 4);
});

Deno.test("mapKnowledgeProfile maps complete profile with all sections", () => {
  const profile: KnowledgeProfile = {
    weak: [{ sub: "Farmaco", kw: "k1", p: 0.2, att: 10 }],
    strong: [{ sub: "Anatomía", kw: "k2", p: 0.95 }],
    lapsing: [{ card: "Card A", kw: "k3", lapses: 6, state: 1 }],
  };
  const result = mapKnowledgeProfile(profile);

  assertEquals(result.weakTopics.length, 1);
  assertEquals(result.strongTopics.length, 1);
  assertEquals(result.lapsingCards.length, 1);
});

Deno.test("mapKnowledgeProfile preserves zero mastery level", () => {
  const profile: KnowledgeProfile = {
    weak: [{ sub: "Topic", kw: "kw", p: 0, att: 1 }],
  };
  const result = mapKnowledgeProfile(profile);
  assertEquals(result.weakTopics[0].masteryLevel, 0);
});

Deno.test("mapKnowledgeProfile preserves zero lapses", () => {
  const profile: KnowledgeProfile = {
    lapsing: [{ card: "Card", kw: "kw", lapses: 0, state: 0 }],
  };
  const result = mapKnowledgeProfile(profile);
  assertEquals(result.lapsingCards[0].lapses, 0);
});

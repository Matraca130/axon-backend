/**
 * Tests for challenge-engine pure functions
 *
 * Tests cover:
 *   1. evaluateChallenge: completion detection + progress calculation
 *   2. selectDailyChallenges: variety, exclusion, count
 *   3. difficultyMultiplier: 3 difficulty levels
 *   4. CHALLENGE_TEMPLATES: structure validation
 *
 * Run: deno test supabase/functions/server/tests/challenge_engine_test.ts
 */

import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  evaluateChallenge,
  selectDailyChallenges,
  difficultyMultiplier,
  CHALLENGE_TEMPLATES,
} from "../challenge-engine.ts";

// === CHALLENGE_TEMPLATES structure ===

Deno.test("CHALLENGE_TEMPLATES: has 12 templates", () => {
  assertEquals(CHALLENGE_TEMPLATES.length, 12);
});

Deno.test("CHALLENGE_TEMPLATES: all have unique slugs", () => {
  const slugs = CHALLENGE_TEMPLATES.map((t) => t.slug);
  assertEquals(slugs.length, new Set(slugs).size);
});

Deno.test("CHALLENGE_TEMPLATES: cover 4 categories", () => {
  const cats = new Set(CHALLENGE_TEMPLATES.map((t) => t.category));
  assertEquals(cats.size, 4);
  assertEquals(cats.has("review"), true);
  assertEquals(cats.has("xp"), true);
  assertEquals(cats.has("streak"), true);
  assertEquals(cats.has("mastery"), true);
});

Deno.test("CHALLENGE_TEMPLATES: all xp_reward > 0", () => {
  for (const t of CHALLENGE_TEMPLATES) {
    assertEquals(t.xp_reward > 0, true, `${t.slug} has xp_reward=${t.xp_reward}`);
  }
});

Deno.test("CHALLENGE_TEMPLATES: all criteria_value > 0", () => {
  for (const t of CHALLENGE_TEMPLATES) {
    assertEquals(t.criteria_value > 0, true, `${t.slug}`);
  }
});

// === evaluateChallenge ===

Deno.test("evaluateChallenge: not completed (0/10)", () => {
  const result = evaluateChallenge({
    challenge_slug: "daily_reviews_10",
    criteria_field: "reviews_today",
    criteria_op: ">=",
    criteria_value: 10,
    current_value: 0,
  });
  assertEquals(result.completed, false);
  assertEquals(result.progress_pct, 0);
  assertEquals(result.current, 0);
  assertEquals(result.target, 10);
});

Deno.test("evaluateChallenge: partial progress (5/10 = 50%)", () => {
  const result = evaluateChallenge({
    challenge_slug: "daily_reviews_10",
    criteria_field: "reviews_today",
    criteria_op: ">=",
    criteria_value: 10,
    current_value: 5,
  });
  assertEquals(result.completed, false);
  assertEquals(result.progress_pct, 50);
});

Deno.test("evaluateChallenge: exactly met (10/10 = completed)", () => {
  const result = evaluateChallenge({
    challenge_slug: "daily_reviews_10",
    criteria_field: "reviews_today",
    criteria_op: ">=",
    criteria_value: 10,
    current_value: 10,
  });
  assertEquals(result.completed, true);
  assertEquals(result.progress_pct, 100);
});

Deno.test("evaluateChallenge: exceeded (15/10 = capped at 100%)", () => {
  const result = evaluateChallenge({
    challenge_slug: "daily_reviews_10",
    criteria_field: "reviews_today",
    criteria_op: ">=",
    criteria_value: 10,
    current_value: 15,
  });
  assertEquals(result.completed, true);
  assertEquals(result.progress_pct, 100);
});

Deno.test("evaluateChallenge: zero target = completed", () => {
  const result = evaluateChallenge({
    challenge_slug: "test",
    criteria_field: "test",
    criteria_op: ">=",
    criteria_value: 0,
    current_value: 0,
  });
  assertEquals(result.completed, true);
  assertEquals(result.progress_pct, 100);
});

// === selectDailyChallenges ===

Deno.test("selectDailyChallenges: returns exactly 3 by default", () => {
  const selected = selectDailyChallenges(CHALLENGE_TEMPLATES, 3);
  assertEquals(selected.length, 3);
});

Deno.test("selectDailyChallenges: only daily templates (<=24h)", () => {
  const selected = selectDailyChallenges(CHALLENGE_TEMPLATES, 10);
  for (const t of selected) {
    assertEquals(t.duration_hours <= 24, true, `${t.slug} has ${t.duration_hours}h`);
  }
});

Deno.test("selectDailyChallenges: excludes specified slugs", () => {
  const excluded = ["daily_reviews_10", "daily_xp_100"];
  const selected = selectDailyChallenges(CHALLENGE_TEMPLATES, 10, excluded);
  for (const t of selected) {
    assertEquals(excluded.includes(t.slug), false, `${t.slug} should be excluded`);
  }
});

Deno.test("selectDailyChallenges: count=1 returns 1", () => {
  const selected = selectDailyChallenges(CHALLENGE_TEMPLATES, 1);
  assertEquals(selected.length, 1);
});

// === difficultyMultiplier ===

Deno.test("difficultyMultiplier: easy = 1.0", () => {
  assertEquals(difficultyMultiplier("easy"), 1.0);
});

Deno.test("difficultyMultiplier: medium = 1.5", () => {
  assertEquals(difficultyMultiplier("medium"), 1.5);
});

Deno.test("difficultyMultiplier: hard = 2.0", () => {
  assertEquals(difficultyMultiplier("hard"), 2.0);
});

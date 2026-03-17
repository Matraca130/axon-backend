/**
 * Tests for badge-engine pure functions
 *
 * Tests cover:
 *   1. evaluateBadgeCriteria -- single and compound conditions
 *   2. hasPrerequisiteTier -- tier progression logic
 *   3. TIER_ORDER -- ordering constants
 *
 * Run: deno test supabase/functions/server/tests/badge_engine_test.ts
 */

import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  evaluateBadgeCriteria,
  hasPrerequisiteTier,
  TIER_ORDER,
  type BadgeEvalContext,
} from "../badge-engine.ts";

const BASE_CONTEXT: BadgeEvalContext = {
  total_xp: 500,
  current_level: 3,
  xp_today: 50,
  xp_this_week: 200,
  current_streak: 5,
  longest_streak: 10,
  total_reviews: 100,
  total_sessions: 20,
  reviews_today: 10,
  sessions_today: 2,
  correct_streak: 5,
  challenges_completed: 0,
};

// === TIER_ORDER ===

Deno.test("TIER_ORDER: correct ordering", () => {
  assertEquals(TIER_ORDER["none"] < TIER_ORDER["bronze"], true);
  assertEquals(TIER_ORDER["bronze"] < TIER_ORDER["silver"], true);
  assertEquals(TIER_ORDER["silver"] < TIER_ORDER["gold"], true);
  assertEquals(TIER_ORDER["gold"] < TIER_ORDER["platinum"], true);
});

// === evaluateBadgeCriteria ===

Deno.test("evaluateBadgeCriteria: single condition met", () => {
  assertEquals(evaluateBadgeCriteria("total_xp >= 500", BASE_CONTEXT), true);
});

Deno.test("evaluateBadgeCriteria: single condition NOT met", () => {
  assertEquals(evaluateBadgeCriteria("total_xp >= 1000", BASE_CONTEXT), false);
});

Deno.test("evaluateBadgeCriteria: compound AND -- both met", () => {
  assertEquals(
    evaluateBadgeCriteria("total_xp >= 500 AND current_streak >= 5", BASE_CONTEXT),
    true,
  );
});

Deno.test("evaluateBadgeCriteria: compound AND -- one not met", () => {
  assertEquals(
    evaluateBadgeCriteria("total_xp >= 500 AND current_streak >= 20", BASE_CONTEXT),
    false,
  );
});

Deno.test("evaluateBadgeCriteria: empty criteria returns false", () => {
  assertEquals(evaluateBadgeCriteria("", BASE_CONTEXT), false);
});

// === hasPrerequisiteTier ===

Deno.test("hasPrerequisiteTier: 'none' tier always passes", () => {
  assertEquals(hasPrerequisiteTier("none", null, new Map()), true);
});

Deno.test("hasPrerequisiteTier: 'bronze' always passes", () => {
  assertEquals(hasPrerequisiteTier("bronze", "reviewer", new Map()), true);
});

Deno.test("hasPrerequisiteTier: 'silver' requires 'bronze'", () => {
  // No bronze earned -> should fail
  assertEquals(hasPrerequisiteTier("silver", "reviewer", new Map()), false);

  // Bronze earned -> should pass
  const earned = new Map<string, { tier: string; achievement_group: string | null }>();
  earned.set("badge-1", { tier: "bronze", achievement_group: "reviewer" });
  assertEquals(hasPrerequisiteTier("silver", "reviewer", earned), true);
});

Deno.test("hasPrerequisiteTier: 'gold' requires 'silver'", () => {
  // Only bronze earned (not silver) -> should fail
  const earned = new Map<string, { tier: string; achievement_group: string | null }>();
  earned.set("badge-1", { tier: "bronze", achievement_group: "reviewer" });
  assertEquals(hasPrerequisiteTier("gold", "reviewer", earned), false);

  // Silver earned -> should pass
  earned.set("badge-2", { tier: "silver", achievement_group: "reviewer" });
  assertEquals(hasPrerequisiteTier("gold", "reviewer", earned), true);
});

Deno.test("hasPrerequisiteTier: different achievement groups are independent", () => {
  const earned = new Map<string, { tier: string; achievement_group: string | null }>();
  earned.set("badge-1", { tier: "bronze", achievement_group: "streaker" });
  // Has bronze for 'streaker', but not for 'reviewer'
  assertEquals(hasPrerequisiteTier("silver", "reviewer", earned), false);
  assertEquals(hasPrerequisiteTier("silver", "streaker", earned), true);
});

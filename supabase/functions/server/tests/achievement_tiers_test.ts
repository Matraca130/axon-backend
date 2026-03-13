/**
 * Tests for achievement tier system
 *
 * Tests cover:
 *   1. Tier ordering correctness
 *   2. Tier progression rules (prerequisite checking)
 *   3. Seed data structure validation
 *   4. Cross-group independence
 *
 * Run: deno test supabase/functions/server/tests/achievement_tiers_test.ts
 */

import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  TIER_ORDER,
  hasPrerequisiteTier,
  evaluateBadgeCriteria,
  type BadgeEvalContext,
} from "../badge-engine.ts";

// --- Seed data definitions (mirrors migration) ---

const TIERED_GROUPS = [
  { group: "xp_collector", tiers: [100, 500, 2000, 10000], field: "total_xp" },
  { group: "streak_master", tiers: [3, 7, 14, 30], field: "current_streak" },
  { group: "reviewer", tiers: [50, 200, 500, 2000], field: "total_reviews" },
  { group: "scholar", tiers: [10, 50, 100, 500], field: "total_sessions" },
];

const TIER_NAMES = ["bronze", "silver", "gold", "platinum"];

// === TIER_ORDER ===

Deno.test("TIER_ORDER: has 5 entries (none + 4 tiers)", () => {
  assertEquals(Object.keys(TIER_ORDER).length, 5);
});

Deno.test("TIER_ORDER: strict ascending order", () => {
  assertEquals(TIER_ORDER["none"], 0);
  assertEquals(TIER_ORDER["bronze"], 1);
  assertEquals(TIER_ORDER["silver"], 2);
  assertEquals(TIER_ORDER["gold"], 3);
  assertEquals(TIER_ORDER["platinum"], 4);
});

// === Tier progression ===

Deno.test("Tier progression: bronze never requires prerequisite", () => {
  for (const group of TIERED_GROUPS) {
    assertEquals(
      hasPrerequisiteTier("bronze", group.group, new Map()),
      true,
      `${group.group} bronze should always pass`,
    );
  }
});

Deno.test("Tier progression: silver requires bronze in same group", () => {
  const earned = new Map<string, { tier: string; achievement_group: string | null }>();

  // Without bronze -> fail
  assertEquals(hasPrerequisiteTier("silver", "xp_collector", earned), false);

  // With bronze -> pass
  earned.set("id-1", { tier: "bronze", achievement_group: "xp_collector" });
  assertEquals(hasPrerequisiteTier("silver", "xp_collector", earned), true);
});

Deno.test("Tier progression: gold requires silver (not just bronze)", () => {
  const earned = new Map<string, { tier: string; achievement_group: string | null }>();
  earned.set("id-1", { tier: "bronze", achievement_group: "reviewer" });

  // Only bronze -> gold should fail
  assertEquals(hasPrerequisiteTier("gold", "reviewer", earned), false);

  // Add silver -> gold should pass
  earned.set("id-2", { tier: "silver", achievement_group: "reviewer" });
  assertEquals(hasPrerequisiteTier("gold", "reviewer", earned), true);
});

Deno.test("Tier progression: platinum requires gold", () => {
  const earned = new Map<string, { tier: string; achievement_group: string | null }>();
  earned.set("id-1", { tier: "bronze", achievement_group: "scholar" });
  earned.set("id-2", { tier: "silver", achievement_group: "scholar" });

  // Has bronze+silver but not gold -> fail
  assertEquals(hasPrerequisiteTier("platinum", "scholar", earned), false);

  // Add gold -> pass
  earned.set("id-3", { tier: "gold", achievement_group: "scholar" });
  assertEquals(hasPrerequisiteTier("platinum", "scholar", earned), true);
});

Deno.test("Tier progression: cross-group tiers are independent", () => {
  const earned = new Map<string, { tier: string; achievement_group: string | null }>();
  // Has bronze in xp_collector
  earned.set("id-1", { tier: "bronze", achievement_group: "xp_collector" });

  // Should NOT satisfy silver requirement for streak_master
  assertEquals(hasPrerequisiteTier("silver", "streak_master", earned), false);

  // But SHOULD satisfy silver requirement for xp_collector
  assertEquals(hasPrerequisiteTier("silver", "xp_collector", earned), true);
});

// === Seed data validation ===

Deno.test("Seed data: each group has 4 tiers", () => {
  for (const group of TIERED_GROUPS) {
    assertEquals(
      group.tiers.length,
      4,
      `${group.group} should have 4 tiers`,
    );
  }
});

Deno.test("Seed data: thresholds are strictly ascending", () => {
  for (const group of TIERED_GROUPS) {
    for (let i = 1; i < group.tiers.length; i++) {
      assertEquals(
        group.tiers[i] > group.tiers[i - 1],
        true,
        `${group.group}: tier ${i} (${group.tiers[i]}) should be > tier ${i - 1} (${group.tiers[i - 1]})`,
      );
    }
  }
});

// === Criteria evaluation with tiers ===

Deno.test("evaluateBadgeCriteria: bronze threshold met but not silver", () => {
  const context: BadgeEvalContext = {
    total_xp: 150,
    current_level: 2,
    xp_today: 0,
    xp_this_week: 0,
    current_streak: 0,
    longest_streak: 0,
    total_reviews: 0,
    total_sessions: 0,
    reviews_today: 0,
    sessions_today: 0,
    correct_streak: 0,
  };

  // Bronze: total_xp >= 100 -> should pass
  assertEquals(evaluateBadgeCriteria("total_xp >= 100", context), true);
  // Silver: total_xp >= 500 -> should fail
  assertEquals(evaluateBadgeCriteria("total_xp >= 500", context), false);
});

Deno.test("evaluateBadgeCriteria: all tiers met at high XP", () => {
  const context: BadgeEvalContext = {
    total_xp: 15000,
    current_level: 12,
    xp_today: 0,
    xp_this_week: 0,
    current_streak: 0,
    longest_streak: 0,
    total_reviews: 0,
    total_sessions: 0,
    reviews_today: 0,
    sessions_today: 0,
    correct_streak: 0,
  };

  assertEquals(evaluateBadgeCriteria("total_xp >= 100", context), true);
  assertEquals(evaluateBadgeCriteria("total_xp >= 500", context), true);
  assertEquals(evaluateBadgeCriteria("total_xp >= 2000", context), true);
  assertEquals(evaluateBadgeCriteria("total_xp >= 10000", context), true);
});

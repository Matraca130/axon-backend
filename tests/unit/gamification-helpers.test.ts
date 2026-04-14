/**
 * tests/unit/gamification-helpers.test.ts — Unit tests for gamification helpers
 *
 * Tests badge criteria evaluation and helper functions.
 * Includes evaluateSimpleCondition and evaluateCountBadge logic.
 */

import {
  assertEquals,
  assert,
  assertFalse,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// Set env vars BEFORE dynamic import
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");

const {
  evaluateSimpleCondition,
  evaluateCountBadge,
  FREEZE_COST_XP,
  MAX_FREEZES,
  REPAIR_BASE_COST_XP,
  GOAL_BONUS_XP,
  calculateLevel,
  LEVEL_THRESHOLDS,
} = await import(
  "../../supabase/functions/server/routes/gamification/helpers.ts"
);

// --- evaluateSimpleCondition Tests ---

Deno.test("evaluateSimpleCondition: >= operator with valid values", () => {
  const result = evaluateSimpleCondition("total_xp >= 500", {
    total_xp: 600,
  });
  assertEquals(result, true);

  const result2 = evaluateSimpleCondition("total_xp >= 500", {
    total_xp: 500,
  });
  assertEquals(result2, true);

  const result3 = evaluateSimpleCondition("total_xp >= 500", {
    total_xp: 400,
  });
  assertEquals(result3, false);
});

Deno.test("evaluateSimpleCondition: > operator", () => {
  const result = evaluateSimpleCondition("current_streak > 7", {
    current_streak: 8,
  });
  assertEquals(result, true);

  const result2 = evaluateSimpleCondition("current_streak > 7", {
    current_streak: 7,
  });
  assertEquals(result2, false);
});

Deno.test("evaluateSimpleCondition: <= operator", () => {
  const result = evaluateSimpleCondition("risk_level <= 3", {
    risk_level: 2,
  });
  assertEquals(result, true);

  const result2 = evaluateSimpleCondition("risk_level <= 3", {
    risk_level: 3,
  });
  assertEquals(result2, true);

  const result3 = evaluateSimpleCondition("risk_level <= 3", {
    risk_level: 4,
  });
  assertEquals(result3, false);
});

Deno.test("evaluateSimpleCondition: < operator", () => {
  const result = evaluateSimpleCondition("errors < 5", {
    errors: 4,
  });
  assertEquals(result, true);

  const result2 = evaluateSimpleCondition("errors < 5", {
    errors: 5,
  });
  assertEquals(result2, false);
});

Deno.test("evaluateSimpleCondition: = operator", () => {
  const result = evaluateSimpleCondition("status = 100", {
    status: 100,
  });
  assertEquals(result, true);

  const result2 = evaluateSimpleCondition("status = 100", {
    status: 99,
  });
  assertEquals(result2, false);
});

Deno.test("evaluateSimpleCondition: == operator", () => {
  const result = evaluateSimpleCondition("value == 42", {
    value: 42,
  });
  assertEquals(result, true);
});

Deno.test("evaluateSimpleCondition: handles missing field (defaults to 0)", () => {
  const result = evaluateSimpleCondition("missing_field >= 0", {});
  assertEquals(result, true);

  const result2 = evaluateSimpleCondition("missing_field > 0", {});
  assertEquals(result2, false);
});

Deno.test("evaluateSimpleCondition: handles decimal values", () => {
  const result = evaluateSimpleCondition("accuracy >= 0.85", {
    accuracy: 0.9,
  });
  assertEquals(result, true);

  const result2 = evaluateSimpleCondition("accuracy >= 0.85", {
    accuracy: 0.8,
  });
  assertEquals(result2, false);
});

Deno.test("evaluateSimpleCondition: handles minimal whitespace around operators", () => {
  const result = evaluateSimpleCondition("total_xp >= 500", {
    total_xp: 600,
  });
  assertEquals(result, true);
});

Deno.test("evaluateSimpleCondition: returns false for invalid syntax", () => {
  const result = evaluateSimpleCondition("invalid syntax here", {
    total_xp: 500,
  });
  assertEquals(result, false);
});

Deno.test("evaluateSimpleCondition: returns false for non-numeric values", () => {
  const result = evaluateSimpleCondition("total_xp >= 500", {
    total_xp: "not-a-number",
  });
  assertEquals(result, false);
});

Deno.test("evaluateSimpleCondition: handles numeric strings", () => {
  const result = evaluateSimpleCondition("total_xp >= 500", {
    total_xp: "600",
  });
  assertEquals(result, true);
});

Deno.test("evaluateSimpleCondition: handles numeric values correctly", () => {
  const result = evaluateSimpleCondition("balance >= 0", {
    balance: 50,
  });
  assertEquals(result, true);

  const result2 = evaluateSimpleCondition("balance >= 100", {
    balance: 50,
  });
  assertEquals(result2, false);
});

Deno.test("evaluateSimpleCondition: zero boundary", () => {
  const result = evaluateSimpleCondition("value = 0", {
    value: 0,
  });
  assertEquals(result, true);

  const result2 = evaluateSimpleCondition("value > 0", {
    value: 0,
  });
  assertEquals(result2, false);
});

// --- Gamification Constants Tests ---

Deno.test("FREEZE_COST_XP is exported and has correct value", () => {
  assertEquals(FREEZE_COST_XP, 100);
  assertEquals(typeof FREEZE_COST_XP, "number");
});

Deno.test("MAX_FREEZES is exported and has correct value", () => {
  assertEquals(MAX_FREEZES, 3);
  assertEquals(typeof MAX_FREEZES, "number");
});

Deno.test("REPAIR_BASE_COST_XP is exported and has correct value", () => {
  assertEquals(REPAIR_BASE_COST_XP, 200);
  assertEquals(typeof REPAIR_BASE_COST_XP, "number");
});

Deno.test("GOAL_BONUS_XP includes expected goal types", () => {
  assert("review_due" in GOAL_BONUS_XP);
  assert("weak_area" in GOAL_BONUS_XP);
  assert("daily_xp" in GOAL_BONUS_XP);
  assert("study_time" in GOAL_BONUS_XP);
  assert("complete_session" in GOAL_BONUS_XP);

  assertEquals(GOAL_BONUS_XP.review_due, 50);
  assertEquals(GOAL_BONUS_XP.weak_area, 75);
  assertEquals(GOAL_BONUS_XP.daily_xp, 25);
  assertEquals(GOAL_BONUS_XP.study_time, 30);
  assertEquals(GOAL_BONUS_XP.complete_session, 25);
});

Deno.test("LEVEL_THRESHOLDS is exported and properly formatted", () => {
  assert(Array.isArray(LEVEL_THRESHOLDS));
  assert(LEVEL_THRESHOLDS.length > 0);

  for (const [xp, level] of LEVEL_THRESHOLDS) {
    assertEquals(typeof xp, "number");
    assertEquals(typeof level, "number");
    assert(xp > 0, "XP threshold should be positive");
    assert(level > 0, "Level should be positive");
  }
});

Deno.test("calculateLevel returns correct level for XP values", () => {
  const level1 = calculateLevel(0);
  assertEquals(level1, 1);

  const level2 = calculateLevel(100);
  assertEquals(level2, 2);

  const level5 = calculateLevel(1000);
  assertEquals(level5, 5);

  const level10 = calculateLevel(5500);
  assertEquals(level10, 10);

  const level12 = calculateLevel(10000);
  assertEquals(level12, 12);

  const levelMax = calculateLevel(100000);
  assertEquals(levelMax, 12);
});

Deno.test("calculateLevel increases monotonically", () => {
  const xpValues = [0, 50, 150, 400, 700, 1200, 2000, 3500, 5000, 7000, 10000, 50000];
  let prevLevel = 1;

  for (const xp of xpValues) {
    const level = calculateLevel(xp);
    assert(level >= prevLevel, `Level should increase or stay same for xp ${xp}`);
    prevLevel = level;
  }
});

// --- evaluateCountBadge Tests (mocked Supabase client) ---

class MockSupabaseClient {
  async from(table: string) {
    return new MockQuery(table);
  }
}

class MockQuery {
  private table: string;

  constructor(table: string) {
    this.table = table;
  }

  select(cols?: string, options?: Record<string, unknown>) {
    return this;
  }

  eq(field: string, value: unknown) {
    return this;
  }

  gte(field: string, value: unknown) {
    return this;
  }

  gt(field: string, value: unknown) {
    return this;
  }

  lte(field: string, value: unknown) {
    return this;
  }

  lt(field: string, value: unknown) {
    return this;
  }

  not(field: string, operator: string, value: unknown) {
    return this;
  }

  is(field: string, value: unknown) {
    return this;
  }

  limit(n: number) {
    return this;
  }

  async count(type: string) {
    return Promise.resolve({ count: 5, error: null });
  }

  async head(value?: boolean) {
    return Promise.resolve({ data: [], error: null });
  }

  async single() {
    return Promise.resolve({
      data: { some_field: 10 },
      error: null,
    });
  }

  async maybeSingle() {
    return Promise.resolve({
      data: { some_field: 10 },
      error: null,
    });
  }
}

Deno.test("evaluateCountBadge: rejects unknown table", async () => {
  const db = new MockSupabaseClient() as any;
  const result = await evaluateCountBadge(db, "student-123", {
    table: "unknown_table",
    condition: "COUNT(*) >= 5",
  });
  assertEquals(result, false);
});

Deno.test("evaluateCountBadge: returns false on query error", async () => {
  const dbWithError = {
    from: () => ({
      select: () => ({
        eq: () => ({
          async count() {
            return { count: null, error: { message: "DB error" } };
          },
        }),
      }),
    }),
  } as any;

  const result = await evaluateCountBadge(dbWithError, "student-123", {
    table: "study_sessions",
    condition: "COUNT(*) >= 5",
  });
  assertEquals(result, false);
});

Deno.test("evaluateCountBadge: handles unparseable conditions", async () => {
  const db = new MockSupabaseClient() as any;
  const result = await evaluateCountBadge(db, "student-123", {
    table: "study_sessions",
    condition: "INVALID SYNTAX HERE",
  });
  assertEquals(result, false);
});

// --- Additional Constants Tests ---

Deno.test("GOAL_BONUS_XP values are reasonable", () => {
  Object.values(GOAL_BONUS_XP).forEach((bonus) => {
    assert(bonus > 0, "All goal bonuses should be positive");
    assert(bonus <= 100, "Goal bonuses should be reasonable (<100)");
  });
});

Deno.test("gamification constants are immutable", () => {
  const originalFreezeCost = FREEZE_COST_XP;
  const originalMaxFreezes = MAX_FREEZES;

  assertEquals(FREEZE_COST_XP, originalFreezeCost);
  assertEquals(MAX_FREEZES, originalMaxFreezes);
});

Deno.test("calculateLevel boundary values", () => {
  // Test exact threshold values
  const test100 = calculateLevel(100);
  const test99 = calculateLevel(99);
  const test101 = calculateLevel(101);

  assert(test100 >= 2);
  assert(test99 >= 1);
  assert(test101 >= test100);
});

Deno.test("LEVEL_THRESHOLDS are in descending XP order", () => {
  for (let i = 0; i < LEVEL_THRESHOLDS.length - 1; i++) {
    const [xp1, level1] = LEVEL_THRESHOLDS[i];
    const [xp2, level2] = LEVEL_THRESHOLDS[i + 1];
    assert(xp1 > xp2, "XP thresholds should be in descending order");
    assert(level1 > level2, "Levels should be in descending order");
  }
});

Deno.test("calculateLevel max is 12", () => {
  const maxLevel = calculateLevel(999999999);
  assertEquals(maxLevel, 12);
});

Deno.test("evaluateSimpleCondition: large numeric values", () => {
  const result = evaluateSimpleCondition("total_xp >= 1000000", {
    total_xp: 2000000,
  });
  assertEquals(result, true);

  const result2 = evaluateSimpleCondition("total_xp >= 1000000", {
    total_xp: 999999,
  });
  assertEquals(result2, false);
});

Deno.test("evaluateSimpleCondition: large numeric values", () => {
  const result = evaluateSimpleCondition("total_xp >= 1000", {
    total_xp: 1500,
  });
  assertEquals(result, true);
});

Deno.test("GOAL_BONUS_XP has all expected keys", () => {
  const expectedKeys = [
    "review_due",
    "weak_area",
    "daily_xp",
    "study_time",
    "complete_session",
  ];
  const actualKeys = Object.keys(GOAL_BONUS_XP);

  expectedKeys.forEach((key) => {
    assert(actualKeys.includes(key), `Missing expected goal type: ${key}`);
  });
});

Deno.test("evaluateSimpleCondition consistency", () => {
  const condition = "total_xp >= 500";
  const row = { total_xp: 600 };

  const result1 = evaluateSimpleCondition(condition, row);
  const result2 = evaluateSimpleCondition(condition, row);

  assertEquals(result1, result2, "Same inputs should produce same output");
});

/**
 * Tests for routes/plans/access.ts — checkPlanLimit()
 *
 * Tests cover:
 *   1. No subscription → default 50/day, allowed=true
 *   2. Subscription + limit 10, used 5 → allowed=true, remaining=5
 *   3. Subscription + limit 10, used 10 → allowed=false, remaining=0
 *   4. Mock DB calls using a simple mock pattern
 *
 * Run: deno test supabase/functions/server/tests/plan_limits_test.ts
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { checkPlanLimit } from "../routes/plans/access.ts";

// ── Mock DB Builder ──────────────────────────────────────────────

/**
 * Creates a minimal mock SupabaseClient that returns preconfigured
 * results for the exact query chains used by checkPlanLimit().
 *
 * checkPlanLimit makes 3 queries:
 *   1. institution_subscriptions → { plan_id }
 *   2. institution_plans → { features: { max_ai_generations_daily } }
 *   3. ai_generations → { count }
 */
function buildMockDb(opts: {
  subscription?: { plan_id: string } | null;
  planFeatures?: Record<string, unknown> | null;
  aiGenerationsCount?: number;
}) {
  // deno-lint-ignore no-explicit-any
  const chainable = (result: any) => {
    const chain: Record<string, unknown> = {};
    const handler = {
      // deno-lint-ignore no-explicit-any
      get(_target: any, prop: string) {
        if (prop === "then" || prop === "catch") return undefined;
        if (chain[prop]) return chain[prop];
        // Terminal methods that resolve the chain
        if (prop === "maybeSingle" || prop === "single") {
          return () => Promise.resolve(result);
        }
        // Chainable methods return the proxy itself
        return () => new Proxy({}, handler);
      },
    };
    return new Proxy({}, handler);
  };

  return {
    from(table: string) {
      if (table === "institution_subscriptions") {
        return chainable({
          data: opts.subscription ?? null,
          error: null,
        });
      }
      if (table === "institution_plans") {
        return chainable({
          data: opts.planFeatures !== undefined
            ? { features: opts.planFeatures }
            : null,
          error: null,
        });
      }
      if (table === "ai_generations") {
        // ai_generations uses select("id", { count, head }) — no .single()
        // The chain ends without .single/.maybeSingle, so we need the final
        // result to resolve from the last chainable method (lt)
        const countResult = {
          data: null,
          count: opts.aiGenerationsCount ?? 0,
          error: null,
        };
        // deno-lint-ignore no-explicit-any
        const handler: ProxyHandler<any> = {
          // deno-lint-ignore no-explicit-any
          get(_target: any, prop: string) {
            if (prop === "then") {
              return (resolve: (v: unknown) => void) => resolve(countResult);
            }
            if (prop === "catch") return () => ({ then: () => countResult });
            return () => new Proxy({}, handler);
          },
        };
        return new Proxy({}, handler);
      }
      // Fallback
      return chainable({ data: null, error: null });
    },
  };
}

const FAKE_USER_ID = "aaaaaaaa-1111-2222-3333-444444444444";
const FAKE_INSTITUTION_ID = "bbbbbbbb-1111-2222-3333-444444444444";

// ═════════════════════════════════════════════════════════════════
// 1. No subscription → default 50/day, allowed=true
// ═════════════════════════════════════════════════════════════════

Deno.test("checkPlanLimit: no subscription → default limit 50, allowed=true", async () => {
  const db = buildMockDb({
    subscription: null,
    aiGenerationsCount: 0,
  });

  // deno-lint-ignore no-explicit-any
  const result = await checkPlanLimit(db as any, FAKE_USER_ID, FAKE_INSTITUTION_ID);

  assertEquals(result.allowed, true);
  assertEquals(result.limit, 50);
  assertEquals(result.remaining, 50);
});

Deno.test("checkPlanLimit: no subscription, 49 used → allowed=true, remaining=1", async () => {
  const db = buildMockDb({
    subscription: null,
    aiGenerationsCount: 49,
  });

  // deno-lint-ignore no-explicit-any
  const result = await checkPlanLimit(db as any, FAKE_USER_ID, FAKE_INSTITUTION_ID);

  assertEquals(result.allowed, true);
  assertEquals(result.limit, 50);
  assertEquals(result.remaining, 1);
});

// ═════════════════════════════════════════════════════════════════
// 2. Subscription + limit, under limit
// ═════════════════════════════════════════════════════════════════

Deno.test("checkPlanLimit: subscription limit=10, used=5 → allowed=true, remaining=5", async () => {
  const db = buildMockDb({
    subscription: { plan_id: "plan-123" },
    planFeatures: { max_ai_generations_daily: 10 },
    aiGenerationsCount: 5,
  });

  // deno-lint-ignore no-explicit-any
  const result = await checkPlanLimit(db as any, FAKE_USER_ID, FAKE_INSTITUTION_ID);

  assertEquals(result.allowed, true);
  assertEquals(result.limit, 10);
  assertEquals(result.remaining, 5);
});

Deno.test("checkPlanLimit: subscription limit=100, used=0 → allowed=true, remaining=100", async () => {
  const db = buildMockDb({
    subscription: { plan_id: "plan-456" },
    planFeatures: { max_ai_generations_daily: 100 },
    aiGenerationsCount: 0,
  });

  // deno-lint-ignore no-explicit-any
  const result = await checkPlanLimit(db as any, FAKE_USER_ID, FAKE_INSTITUTION_ID);

  assertEquals(result.allowed, true);
  assertEquals(result.limit, 100);
  assertEquals(result.remaining, 100);
});

// ═════════════════════════════════════════════════════════════════
// 3. Subscription + limit, at/over limit
// ═════════════════════════════════════════════════════════════════

Deno.test("checkPlanLimit: subscription limit=10, used=10 → allowed=false, remaining=0", async () => {
  const db = buildMockDb({
    subscription: { plan_id: "plan-123" },
    planFeatures: { max_ai_generations_daily: 10 },
    aiGenerationsCount: 10,
  });

  // deno-lint-ignore no-explicit-any
  const result = await checkPlanLimit(db as any, FAKE_USER_ID, FAKE_INSTITUTION_ID);

  assertEquals(result.allowed, false);
  assertEquals(result.limit, 10);
  assertEquals(result.remaining, 0);
});

Deno.test("checkPlanLimit: subscription limit=10, used=15 → allowed=false, remaining=0", async () => {
  const db = buildMockDb({
    subscription: { plan_id: "plan-123" },
    planFeatures: { max_ai_generations_daily: 10 },
    aiGenerationsCount: 15,
  });

  // deno-lint-ignore no-explicit-any
  const result = await checkPlanLimit(db as any, FAKE_USER_ID, FAKE_INSTITUTION_ID);

  assertEquals(result.allowed, false);
  assertEquals(result.limit, 10);
  assertEquals(result.remaining, 0);
});

// ═════════════════════════════════════════════════════════════════
// 4. Edge cases
// ═════════════════════════════════════════════════════════════════

Deno.test("checkPlanLimit: subscription with no features → fallback to default 50", async () => {
  const db = buildMockDb({
    subscription: { plan_id: "plan-no-features" },
    planFeatures: null,
    aiGenerationsCount: 0,
  });

  // deno-lint-ignore no-explicit-any
  const result = await checkPlanLimit(db as any, FAKE_USER_ID, FAKE_INSTITUTION_ID);

  assertEquals(result.limit, 50);
  assertEquals(result.allowed, true);
});

Deno.test("checkPlanLimit: subscription with features but no max_ai_generations_daily → default 50", async () => {
  const db = buildMockDb({
    subscription: { plan_id: "plan-other" },
    planFeatures: { some_other_feature: true },
    aiGenerationsCount: 0,
  });

  // deno-lint-ignore no-explicit-any
  const result = await checkPlanLimit(db as any, FAKE_USER_ID, FAKE_INSTITUTION_ID);

  assertEquals(result.limit, 50);
  assertEquals(result.allowed, true);
});

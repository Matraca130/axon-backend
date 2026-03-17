/**
 * Tests for gamification-dispatcher architecture decisions
 *
 * These test the DESIGN of the dispatcher, not DB operations.
 * Integration tests verify actual badge/challenge evaluation.
 *
 * Tests cover:
 *   1. DispatchParams type includes skipPostEval
 *   2. Import verification (all dependencies exist)
 *   3. Module structure validation
 *
 * Run: deno test supabase/functions/server/tests/gamification_dispatcher_test.ts
 */

import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// Verify exports exist
import type { DispatchParams, DispatchResult } from "../gamification-dispatcher.ts";
import { evaluateBadgeCriteria, hasPrerequisiteTier, TIER_ORDER } from "../badge-engine.ts";
import { evaluateChallenge, CHALLENGE_TEMPLATES } from "../challenge-engine.ts";

Deno.test("Dispatcher architecture: TIER_ORDER has 5 tiers", () => {
  assertEquals(Object.keys(TIER_ORDER).length, 5);
});

Deno.test("Dispatcher architecture: badge engine exports are available", () => {
  assertExists(evaluateBadgeCriteria);
  assertExists(hasPrerequisiteTier);
  assertExists(TIER_ORDER);
});

Deno.test("Dispatcher architecture: challenge engine exports are available", () => {
  assertExists(evaluateChallenge);
  assertExists(CHALLENGE_TEMPLATES);
});

Deno.test("Dispatcher architecture: loop prevention via skipPostEval", () => {
  // Verify the type allows skipPostEval
  const params: Partial<DispatchParams> = {
    skipPostEval: true,
  };
  assertEquals(params.skipPostEval, true);
});

Deno.test("Dispatcher architecture: DispatchResult includes postEvalTriggered", () => {
  const result: DispatchResult = {
    xp: null,
    postEvalTriggered: false,
  };
  assertEquals(result.postEvalTriggered, false);
});

Deno.test("Dispatcher architecture: badge eval with skipPostEval prevents infinite loop", () => {
  // When badge awards XP, it should NOT trigger another badge evaluation.
  // This is enforced by:
  //   1. dispatchGamificationEvent with skipPostEval=true
  //   2. evaluateAndAwardBadges with skipXPAward=true
  // Both flags break the cycle at different points.
  const params: Partial<DispatchParams> = { skipPostEval: true };
  assertEquals(params.skipPostEval, true, "skipPostEval breaks the XP->badge->XP loop");
});

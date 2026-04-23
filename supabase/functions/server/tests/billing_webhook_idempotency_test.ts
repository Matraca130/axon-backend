/**
 * Tests for routes/billing/webhook-idempotency.ts
 *
 * Covers the decision branching that sits between the INSERT into
 * processed_webhook_events and the business logic switch. Each branch
 * corresponds to a review-finding scenario on PR #326:
 *
 *   - "proceed" : INSERT succeeded → run business logic.
 *   - "dedup"   : 23505 unique-violation → 200 deduplicated.
 *   - "retry"   : any other DB error → 500 so Stripe retries. Review
 *                 finding HIGH: previously the handler "logged and
 *                 proceeded best-effort" which left business logic
 *                 running without idempotency protection.
 *
 * The event.id-missing branch and the compensating DELETE on catch
 * live inside webhook.ts itself (they need the Hono Context + the
 * admin client); they're not in this pure module.
 *
 * Run: deno test supabase/functions/server/tests/billing_webhook_idempotency_test.ts
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decideIdempotencyResult,
  type DedupeInsertError,
} from "../routes/billing/webhook-idempotency.ts";

// ─── proceed ─────────────────────────────────────────────

Deno.test("decideIdempotencyResult: null error → proceed", () => {
  assertEquals(decideIdempotencyResult(null), { action: "proceed" });
});

// ─── dedup ───────────────────────────────────────────────

Deno.test("decideIdempotencyResult: 23505 unique-violation → dedup", () => {
  const err: DedupeInsertError = {
    code: "23505",
    message: "duplicate key value violates unique constraint",
  };
  assertEquals(decideIdempotencyResult(err), { action: "dedup" });
});

// ─── retry ───────────────────────────────────────────────

Deno.test("decideIdempotencyResult: other DB error → retry 500", () => {
  const err: DedupeInsertError = {
    code: "42P01",
    message: 'relation "processed_webhook_events" does not exist',
  };
  const decision = decideIdempotencyResult(err);
  assertEquals(decision.action, "retry");
  if (decision.action === "retry") {
    assertEquals(decision.status, 500);
    assertEquals(decision.message, err.message);
  }
});

Deno.test("decideIdempotencyResult: missing code treated as retry (not proceed)", () => {
  // Review finding HIGH: any non-23505 error must retry, including
  // the "no code at all" case. Previously the handler fell through.
  const err: DedupeInsertError = { message: "connection timeout" };
  const decision = decideIdempotencyResult(err);
  assertEquals(decision.action, "retry");
  if (decision.action === "retry") assertEquals(decision.status, 500);
});

Deno.test("decideIdempotencyResult: permission-denied (42501) → retry, NOT proceed", () => {
  const err: DedupeInsertError = {
    code: "42501",
    message: "permission denied for table processed_webhook_events",
  };
  assertEquals(decideIdempotencyResult(err).action, "retry");
});

Deno.test("decideIdempotencyResult: serialization_failure (40001) → retry", () => {
  const err: DedupeInsertError = {
    code: "40001",
    message: "could not serialize access due to concurrent update",
  };
  assertEquals(decideIdempotencyResult(err).action, "retry");
});

// ─── shape sanity ────────────────────────────────────────

Deno.test("decideIdempotencyResult: empty-string code is treated as 'other' → retry", () => {
  const err: DedupeInsertError = { code: "", message: "unknown" };
  assertEquals(decideIdempotencyResult(err).action, "retry");
});

/**
 * routes/billing/webhook-idempotency.ts — Decision helpers for the
 * Stripe-webhook idempotency path. Kept as a pure module so the
 * branching logic can be unit-tested without mocking Hono + Supabase.
 *
 * See webhook.ts for how these are wired together.
 */

export type DedupeInsertError = { code?: string; message: string } | null;

/**
 * The action to take after attempting to INSERT a row in
 * processed_webhook_events for the current delivery.
 */
export type IdempotencyDecision =
  /** Normal path: INSERT succeeded; run business logic. */
  | { action: "proceed" }
  /** 23505 unique-violation: duplicate Stripe delivery; return 200. */
  | { action: "dedup" }
  /**
   * Any other DB error means we have no idempotency guarantee. Return
   * 500 so Stripe retries — do NOT fall through to business logic.
   */
  | { action: "retry"; status: 500; message: string };

export function decideIdempotencyResult(err: DedupeInsertError): IdempotencyDecision {
  if (!err) return { action: "proceed" };
  if (err.code === "23505") return { action: "dedup" };
  return {
    action: "retry",
    status: 500,
    message: err.message,
  };
}

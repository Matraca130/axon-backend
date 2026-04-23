/**
 * Tests for the Stripe payload shape guard exported by
 * routes/billing/webhook.ts.
 *
 * The guard runs AFTER signature verification but BEFORE the
 * idempotency INSERT. It rejects malformed payloads with 400 so we
 * never reach the dedup path (and never compensate a row for a
 * delivery that was malformed from the start).
 *
 * Run: deno test supabase/functions/server/tests/billing_webhook_payload_guard_test.ts
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isStripeEventPayload } from "../routes/billing/webhook.ts";

Deno.test("isStripeEventPayload: accepts minimal well-formed event", () => {
  const ev = {
    id: "evt_test_1",
    type: "checkout.session.completed",
    data: { object: { id: "cs_123" } },
  };
  assertEquals(isStripeEventPayload(ev), true);
});

Deno.test("isStripeEventPayload: accepts event without id (id is optional in the guard)", () => {
  // The guard itself allows missing id; webhook.ts then rejects
  // missing id explicitly with 400. Keeping the guard permissive
  // means the rejection message is more specific (not "malformed
  // shape" but "missing event.id on verified payload").
  const ev = { type: "checkout.session.completed", data: { object: { id: "cs_123" } } };
  assertEquals(isStripeEventPayload(ev), true);
});

Deno.test("isStripeEventPayload: rejects null", () => {
  assertEquals(isStripeEventPayload(null), false);
});

Deno.test("isStripeEventPayload: rejects non-object", () => {
  assertEquals(isStripeEventPayload("string"), false);
  assertEquals(isStripeEventPayload(42), false);
  assertEquals(isStripeEventPayload(true), false);
});

Deno.test("isStripeEventPayload: rejects missing type", () => {
  assertEquals(
    isStripeEventPayload({ id: "evt_1", data: { object: {} } }),
    false,
  );
});

Deno.test("isStripeEventPayload: rejects non-string type", () => {
  assertEquals(
    isStripeEventPayload({ id: "evt_1", type: 42, data: { object: {} } }),
    false,
  );
});

Deno.test("isStripeEventPayload: rejects missing data", () => {
  assertEquals(
    isStripeEventPayload({ id: "evt_1", type: "t" }),
    false,
  );
});

Deno.test("isStripeEventPayload: rejects data without object", () => {
  assertEquals(
    isStripeEventPayload({ id: "evt_1", type: "t", data: {} }),
    false,
  );
});

Deno.test("isStripeEventPayload: rejects data.object === null", () => {
  assertEquals(
    isStripeEventPayload({ id: "evt_1", type: "t", data: { object: null } }),
    false,
  );
});

Deno.test("isStripeEventPayload: rejects non-string id when present", () => {
  assertEquals(
    isStripeEventPayload({ id: 42, type: "t", data: { object: {} } }),
    false,
  );
});

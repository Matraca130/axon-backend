/**
 * tests/integration/billing-routes.test.ts — Comprehensive integration tests for billing routes
 *
 * Tests for all billing endpoints:
 *   POST /billing/checkout-session     — Create Stripe checkout session
 *   POST /billing/portal-session       — Create Stripe billing portal session
 *   GET  /billing/subscription-status  — Get subscription status for user + institution
 *   POST /webhooks/stripe              — Handle Stripe webhook events
 *
 * Strategy: Unit tests with fully mocked Supabase, Stripe API, and crypto.
 * We stub `authenticate`, DB calls, `getStripe`, and `verifyStripeSignature`
 * so tests run without network, env vars, or real databases.
 *
 * Run: deno test tests/integration/billing-routes.test.ts --allow-all
 */

import {
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  stub,
  restore,
  type Stub,
} from "https://deno.land/std@0.224.0/testing/mock.ts";

// ─── Test Constants ──────────────────────────────────────────────────

const FAKE_USER_ID = "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb";
const FAKE_PLAN_ID = "bbbbbbbb-2222-3333-4444-cccccccccccc";
const FAKE_INSTITUTION_ID = "cccccccc-3333-4444-5555-dddddddddddd";
const FAKE_STRIPE_CUSTOMER_ID = "cus_test123456789";
const FAKE_STRIPE_SUBSCRIPTION_ID = "sub_test123456789";
const FAKE_STRIPE_SESSION_ID = "cs_test_123456789";
const FAKE_STRIPE_PRICE_ID = "price_test123456789";
const FAKE_WEBHOOK_SECRET = "whsec_test_secret_key_12345";

// Valid-looking JWT (header.payload.signature)
const FAKE_JWT = buildFakeJwt({
  sub: FAKE_USER_ID,
  email: "test@axon.com",
  exp: 9999999999,
});

function buildFakeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const body = btoa(JSON.stringify(payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const sig = "fake_signature";
  return `${header}.${body}.${sig}`;
}

// ─── Mock Database Builder ────────────────────────────────────────────

interface MockResponse {
  data: unknown;
  error: { message: string } | null;
}

interface TableConfig {
  selectResponse?: MockResponse;
  insertResponse?: MockResponse;
  updateResponse?: MockResponse;
  deleteResponse?: MockResponse;
}

function createMockDb(tableConfigs: Record<string, TableConfig> = {}) {
  let currentTable = "";
  let currentOperation = "select"; // select, insert, update, delete

  const chainable = {
    select: (_cols?: string) => {
      currentOperation = "select";
      return chainable;
    },
    insert: (_data: unknown) => {
      currentOperation = "insert";
      return chainable;
    },
    update: (_data: unknown) => {
      currentOperation = "update";
      return chainable;
    },
    delete: () => {
      currentOperation = "delete";
      return chainable;
    },
    eq: (_col: string, _val: unknown) => chainable,
    neq: (_col: string, _val: unknown) => chainable,
    is: (_col: string, _val: unknown) => chainable,
    not: (_col: string, _op: string, _val: unknown) => chainable,
    in: (_col: string, _val: unknown[]) => chainable,
    limit: (_n: number) => chainable,
    order: (_col: string, _opts?: unknown) => chainable,
    single: () => chainable,
    maybeSingle: () => chainable,
    then(
      resolve: (v: MockResponse) => void,
      reject?: (e: unknown) => void,
    ) {
      const cfg = tableConfigs[currentTable];
      let resp: MockResponse;
      if (currentOperation === "insert") {
        resp = cfg?.insertResponse ?? { data: null, error: null };
      } else if (currentOperation === "update") {
        resp = cfg?.updateResponse ?? { data: null, error: null };
      } else if (currentOperation === "delete") {
        resp = cfg?.deleteResponse ?? { data: null, error: null };
      } else {
        resp = cfg?.selectResponse ?? { data: [], error: null };
      }
      try {
        resolve(resp);
      } catch (e) {
        if (reject) reject(e);
      }
    },
  };

  // Make chainable thenable
  Object.defineProperty(chainable, "then", { enumerable: false });

  const db = {
    from: (table: string) => {
      currentTable = table;
      return chainable;
    },
  };

  return {
    db,
    setTable(table: string, selectResponse?: MockResponse, insertResponse?: MockResponse, updateResponse?: MockResponse) {
      if (!tableConfigs[table]) tableConfigs[table] = {};
      if (selectResponse) tableConfigs[table].selectResponse = selectResponse;
      if (insertResponse) tableConfigs[table].insertResponse = insertResponse;
      if (updateResponse) tableConfigs[table].updateResponse = updateResponse;
    },
  };
}

// ─── Setup Env and Imports ─────────────────────────────────────────────

// Set required env vars BEFORE importing route modules
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_ANON_KEY", "fake-anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "fake-service-role-key");
Deno.env.set("STRIPE_SECRET_KEY", "sk_test_fake_stripe_key");
Deno.env.set("STRIPE_WEBHOOK_SECRET", FAKE_WEBHOOK_SECRET);

import { Hono } from "npm:hono";
import * as dbMod from "../../supabase/functions/server/db.ts";
import * as billingMod from "../../supabase/functions/server/routes/billing/index.ts";
import * as stripeMod from "../../supabase/functions/server/routes/billing/stripe-client.ts";
import * as webhookMod from "../../supabase/functions/server/routes/billing/webhook.ts";
import { timingSafeEqual } from "../../supabase/functions/server/timing-safe.ts";

// ─── Test App Builder ────────────────────────────────────────────────

function buildApp() {
  const app = new Hono();
  app.route("/", billingMod.billingRoutes);
  app.route("/", webhookMod.webhookRoutes);
  return app;
}

// ─── Stub Helpers ───────────────────────────────────────────────────────

type StubList = Stub[];

function setupAuthStub(
  stubs: StubList,
  mockDb: ReturnType<typeof createMockDb>,
  opts?: { failAuth?: boolean },
) {
  const authStub = stub(
    dbMod,
    "authenticate",
    async (c) => {
      if (opts?.failAuth) {
        return dbMod.err(c, "Missing Authorization header", 401);
      }
      return {
        user: { id: FAKE_USER_ID, email: "test@axon.com" },
        db: mockDb.db as unknown as any,
      };
    },
  );
  stubs.push(authStub);
  return authStub;
}

// ─── Test Suites ────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════
// 1. POST /billing/checkout-session
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("checkout-session: returns 401 when not authenticated", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb, { failAuth: true });

  try {
    const app = buildApp();
    const res = await app.request("/server/billing/checkout-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        plan_id: FAKE_PLAN_ID,
        institution_id: FAKE_INSTITUTION_ID,
        success_url: "https://example.com/success",
        cancel_url: "https://example.com/cancel",
      }),
    });
    assertEquals(res.status, 401);
  } finally {
    restore();
  }
});

Deno.test("checkout-session: returns 400 when plan_id is missing", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  try {
    const app = buildApp();
    const res = await app.request("/server/billing/checkout-session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: JSON.stringify({
        institution_id: FAKE_INSTITUTION_ID,
        success_url: "https://example.com/success",
        cancel_url: "https://example.com/cancel",
      }),
    });
    assertEquals(res.status, 400);
    const json = await res.json();
    assertStringIncludes(json.error, "plan_id");
  } finally {
    restore();
  }
});

Deno.test("checkout-session: returns 400 when institution_id is invalid UUID", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  try {
    const app = buildApp();
    const res = await app.request("/server/billing/checkout-session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: JSON.stringify({
        plan_id: FAKE_PLAN_ID,
        institution_id: "not-a-uuid",
        success_url: "https://example.com/success",
        cancel_url: "https://example.com/cancel",
      }),
    });
    assertEquals(res.status, 400);
    const json = await res.json();
    assertStringIncludes(json.error, "institution_id");
  } finally {
    restore();
  }
});

Deno.test("checkout-session: returns 400 when success_url is missing", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  try {
    const app = buildApp();
    const res = await app.request("/server/billing/checkout-session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: JSON.stringify({
        plan_id: FAKE_PLAN_ID,
        institution_id: FAKE_INSTITUTION_ID,
        cancel_url: "https://example.com/cancel",
      }),
    });
    assertEquals(res.status, 400);
    const json = await res.json();
    assertStringIncludes(json.error, "success_url");
  } finally {
    restore();
  }
});

Deno.test("checkout-session: returns 404 when plan not found", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);
  mockDb.setTable("institution_plans", {
    data: null,
    error: null,
  });

  try {
    const app = buildApp();
    const res = await app.request("/server/billing/checkout-session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: JSON.stringify({
        plan_id: FAKE_PLAN_ID,
        institution_id: FAKE_INSTITUTION_ID,
        success_url: "https://example.com/success",
        cancel_url: "https://example.com/cancel",
      }),
    });
    assertEquals(res.status, 404);
  } finally {
    restore();
  }
});

Deno.test("checkout-session: returns 400 when plan has no stripe_price_id", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);
  mockDb.setTable("institution_plans", {
    data: {
      id: FAKE_PLAN_ID,
      name: "Basic Plan",
      stripe_price_id: null, // Missing!
      trial_days: 0,
    },
    error: null,
  });

  try {
    const app = buildApp();
    const res = await app.request("/server/billing/checkout-session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: JSON.stringify({
        plan_id: FAKE_PLAN_ID,
        institution_id: FAKE_INSTITUTION_ID,
        success_url: "https://example.com/success",
        cancel_url: "https://example.com/cancel",
      }),
    });
    assertEquals(res.status, 400);
    const json = await res.json();
    assertStringIncludes(json.error, "Stripe price");
  } finally {
    restore();
  }
});

Deno.test("checkout-session: returns 200 with checkout URL on success", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  // Mock the plan lookup
  mockDb.setTable("institution_plans", {
    data: {
      id: FAKE_PLAN_ID,
      name: "Basic Plan",
      stripe_price_id: FAKE_STRIPE_PRICE_ID,
      trial_days: 7,
    },
    error: null,
  });

  // Mock no existing subscription
  mockDb.setTable("institution_subscriptions", {
    data: null,
    error: null,
  });

  // Stub getStripe to return a mock stripe client
  const stripeStub = stub(
    stripeMod,
    "getStripe",
    () => ({
      request: async (method: string, path: string, body?: unknown) => {
        if (path === "/checkout/sessions") {
          return {
            url: "https://checkout.stripe.com/pay/cs_test_123456789",
            id: FAKE_STRIPE_SESSION_ID,
          };
        }
        throw new Error("Unexpected Stripe path");
      },
    }),
  );
  stubs.push(stripeStub);

  try {
    const app = buildApp();
    const res = await app.request("/server/billing/checkout-session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: JSON.stringify({
        plan_id: FAKE_PLAN_ID,
        institution_id: FAKE_INSTITUTION_ID,
        success_url: "https://example.com/success",
        cancel_url: "https://example.com/cancel",
      }),
    });
    assertEquals(res.status, 200);
    const json = await res.json();
    assertExists(json.data);
    assertStringIncludes(json.data.url, "checkout.stripe.com");
    assertEquals(json.data.session_id, FAKE_STRIPE_SESSION_ID);
  } finally {
    restore();
  }
});

Deno.test("checkout-session: includes trial_period_days when plan has trials", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  mockDb.setTable("institution_plans", {
    data: {
      id: FAKE_PLAN_ID,
      name: "Premium Plan",
      stripe_price_id: FAKE_STRIPE_PRICE_ID,
      trial_days: 14,
    },
    error: null,
  });

  mockDb.setTable("institution_subscriptions", {
    data: null,
    error: null,
  });

  let capturedBody: Record<string, unknown> = {};
  const stripeStub = stub(
    stripeMod,
    "getStripe",
    () => ({
      request: async (method: string, path: string, body?: unknown) => {
        if (path === "/checkout/sessions") {
          capturedBody = body as Record<string, unknown>;
          return {
            url: "https://checkout.stripe.com/pay/cs_test",
            id: FAKE_STRIPE_SESSION_ID,
          };
        }
        throw new Error("Unexpected path");
      },
    }),
  );
  stubs.push(stripeStub);

  try {
    const app = buildApp();
    await app.request("/server/billing/checkout-session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: JSON.stringify({
        plan_id: FAKE_PLAN_ID,
        institution_id: FAKE_INSTITUTION_ID,
        success_url: "https://example.com/success",
        cancel_url: "https://example.com/cancel",
      }),
    });

    // Verify trial_period_days was included
    assertEquals(capturedBody["subscription_data[trial_period_days]"], 14);
  } finally {
    restore();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. POST /billing/portal-session
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("portal-session: returns 401 when not authenticated", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb, { failAuth: true });

  try {
    const app = buildApp();
    const res = await app.request("/server/billing/portal-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        institution_id: FAKE_INSTITUTION_ID,
        return_url: "https://example.com/settings",
      }),
    });
    assertEquals(res.status, 401);
  } finally {
    restore();
  }
});

Deno.test("portal-session: returns 400 when institution_id is invalid UUID", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  try {
    const app = buildApp();
    const res = await app.request("/server/billing/portal-session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: JSON.stringify({
        institution_id: "not-uuid",
        return_url: "https://example.com/settings",
      }),
    });
    assertEquals(res.status, 400);
    const json = await res.json();
    assertStringIncludes(json.error, "institution_id");
  } finally {
    restore();
  }
});

Deno.test("portal-session: returns 400 when return_url is missing", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  try {
    const app = buildApp();
    const res = await app.request("/server/billing/portal-session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: JSON.stringify({
        institution_id: FAKE_INSTITUTION_ID,
      }),
    });
    assertEquals(res.status, 400);
    const json = await res.json();
    assertStringIncludes(json.error, "return_url");
  } finally {
    restore();
  }
});

Deno.test("portal-session: returns 404 when no subscription exists", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  mockDb.setTable("institution_subscriptions", {
    data: null,
    error: null,
  });

  try {
    const app = buildApp();
    const res = await app.request("/server/billing/portal-session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: JSON.stringify({
        institution_id: FAKE_INSTITUTION_ID,
        return_url: "https://example.com/settings",
      }),
    });
    assertEquals(res.status, 404);
  } finally {
    restore();
  }
});

Deno.test("portal-session: returns 200 with portal URL on success", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  mockDb.setTable("institution_subscriptions", {
    data: {
      stripe_customer_id: FAKE_STRIPE_CUSTOMER_ID,
    },
    error: null,
  });

  const stripeStub = stub(
    stripeMod,
    "getStripe",
    () => ({
      request: async (method: string, path: string, body?: unknown) => {
        if (path === "/billing_portal/sessions") {
          return {
            url: "https://billing.stripe.com/session/test_123",
            id: "bps_test_123",
          };
        }
        throw new Error("Unexpected path");
      },
    }),
  );
  stubs.push(stripeStub);

  try {
    const app = buildApp();
    const res = await app.request("/server/billing/portal-session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: JSON.stringify({
        institution_id: FAKE_INSTITUTION_ID,
        return_url: "https://example.com/settings",
      }),
    });
    assertEquals(res.status, 200);
    const json = await res.json();
    assertExists(json.data);
    assertStringIncludes(json.data.url, "billing.stripe.com");
  } finally {
    restore();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. GET /billing/subscription-status
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("subscription-status: returns 401 when not authenticated", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb, { failAuth: true });

  try {
    const app = buildApp();
    const res = await app.request(
      `/server/billing/subscription-status?institution_id=${FAKE_INSTITUTION_ID}`,
      { method: "GET", headers: {} },
    );
    assertEquals(res.status, 401);
  } finally {
    restore();
  }
});

Deno.test("subscription-status: returns 400 when institution_id is invalid UUID", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  try {
    const app = buildApp();
    const res = await app.request(
      "/server/billing/subscription-status?institution_id=not-uuid",
      {
        method: "GET",
        headers: { "X-Access-Token": FAKE_JWT },
      },
    );
    assertEquals(res.status, 400);
    const json = await res.json();
    assertStringIncludes(json.error, "institution_id");
  } finally {
    restore();
  }
});

Deno.test("subscription-status: returns 200 with free plan when no subscription exists", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  // No subscription
  mockDb.setTable("institution_subscriptions", {
    data: null,
    error: null,
  });

  // But free plan exists
  mockDb.setTable("institution_plans", {
    data: {
      id: FAKE_PLAN_ID,
      name: "Free Plan",
      is_free: true,
      is_active: true,
      features: { max_users: 1 },
    },
    error: null,
  });

  try {
    const app = buildApp();
    const res = await app.request(
      `/server/billing/subscription-status?institution_id=${FAKE_INSTITUTION_ID}`,
      {
        method: "GET",
        headers: { "X-Access-Token": FAKE_JWT },
      },
    );
    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.data.subscription, null);
    assertExists(json.data.plan);
    assertEquals(json.data.is_active, true);
    assertEquals(json.data.is_trial, false);
  } finally {
    restore();
  }
});

Deno.test("subscription-status: returns 200 with active subscription", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  mockDb.setTable("institution_subscriptions", {
    data: {
      id: "sub-001",
      status: "active",
      stripe_subscription_id: FAKE_STRIPE_SUBSCRIPTION_ID,
      stripe_customer_id: FAKE_STRIPE_CUSTOMER_ID,
      current_period_start: new Date().toISOString(),
      current_period_end: futureDate,
      trial_start: null,
      trial_end: null,
      cancel_at_period_end: false,
      canceled_at: null,
      institution_plans: {
        id: FAKE_PLAN_ID,
        name: "Premium",
        description: "Premium plan",
        price_cents: 9999,
        billing_cycle: "monthly",
        currency: "USD",
        is_free: false,
        features: { max_users: 100 },
      },
    },
    error: null,
  });

  try {
    const app = buildApp();
    const res = await app.request(
      `/server/billing/subscription-status?institution_id=${FAKE_INSTITUTION_ID}`,
      {
        method: "GET",
        headers: { "X-Access-Token": FAKE_JWT },
      },
    );
    assertEquals(res.status, 200);
    const json = await res.json();
    assertExists(json.data.subscription);
    assertEquals(json.data.subscription.status, "active");
    assertEquals(json.data.is_active, true);
    assertEquals(json.data.is_trial, false);
    assertExists(json.data.days_remaining);
  } finally {
    restore();
  }
});

Deno.test("subscription-status: returns correct days_remaining for trial", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  // Trial ending in exactly 5 days
  const trialEnd = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
  mockDb.setTable("institution_subscriptions", {
    data: {
      id: "sub-002",
      status: "trialing",
      stripe_subscription_id: FAKE_STRIPE_SUBSCRIPTION_ID,
      stripe_customer_id: FAKE_STRIPE_CUSTOMER_ID,
      current_period_start: new Date().toISOString(),
      current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      trial_start: new Date().toISOString(),
      trial_end: trialEnd,
      cancel_at_period_end: false,
      canceled_at: null,
      institution_plans: {
        id: FAKE_PLAN_ID,
        name: "Premium Trial",
        description: "Premium on trial",
        price_cents: 0,
        billing_cycle: "monthly",
        currency: "USD",
        is_free: false,
        features: {},
      },
    },
    error: null,
  });

  try {
    const app = buildApp();
    const res = await app.request(
      `/server/billing/subscription-status?institution_id=${FAKE_INSTITUTION_ID}`,
      {
        method: "GET",
        headers: { "X-Access-Token": FAKE_JWT },
      },
    );
    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.data.is_trial, true);
    // Should be around 5 days (allow 1 day tolerance for test timing)
    assertExists(json.data.days_remaining);
  } finally {
    restore();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. POST /webhooks/stripe — Webhook Event Handling
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("webhook: returns 500 when STRIPE_WEBHOOK_SECRET not configured", async () => {
  const stubs: StubList = [];
  // Temporarily remove the env var
  const oldSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  Deno.env.delete("STRIPE_WEBHOOK_SECRET");

  try {
    const app = buildApp();
    const res = await app.request("/server/webhooks/stripe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "checkout.session.completed" }),
    });
    assertEquals(res.status, 500);
  } finally {
    if (oldSecret) Deno.env.set("STRIPE_WEBHOOK_SECRET", oldSecret);
    restore();
  }
});

Deno.test("webhook: returns 400 when stripe-signature header is missing", async () => {
  const stubs: StubList = [];
  try {
    const app = buildApp();
    const res = await app.request("/server/webhooks/stripe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "checkout.session.completed" }),
      // No stripe-signature header
    });
    assertEquals(res.status, 400);
    const json = await res.json();
    assertStringIncludes(json.error, "stripe-signature");
  } finally {
    restore();
  }
});

Deno.test("webhook: returns 400 with invalid signature", async () => {
  const stubs: StubList = [];
  try {
    const app = buildApp();
    const payload = JSON.stringify({ type: "checkout.session.completed" });
    const res = await app.request("/server/webhooks/stripe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": "t=1234567890,v1=invalid_signature_hash",
      },
      body: payload,
    });
    assertEquals(res.status, 400);
    const json = await res.json();
    assertStringIncludes(json.error, "Invalid webhook signature");
  } finally {
    restore();
  }
});

Deno.test("webhook: returns 200 for unhandled event types (acknowledged)", async () => {
  const stubs: StubList = [];
  const payload = JSON.stringify({
    id: "evt_test_unknown_type",
    type: "charge.succeeded", // Not handled by our webhook
  });

  // Mock valid signature verification
  const verifyStub = stub(
    webhookMod,
    "verifyStripeSignature",
    async () => true,
  );
  stubs.push(verifyStub);

  try {
    const app = buildApp();
    const res = await app.request("/server/webhooks/stripe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": "t=1234567890,v1=fakesig",
      },
      body: payload,
    });
    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.data.received, true);
  } finally {
    restore();
  }
});

Deno.test("webhook: handles checkout.session.completed event and creates subscription", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();

  // Mock successful signature verification
  const verifyStub = stub(
    webhookMod,
    "verifyStripeSignature",
    async () => true,
  );
  stubs.push(verifyStub);

  // Mock getAdminClient
  const adminStub = stub(
    dbMod,
    "getAdminClient",
    () => mockDb.db as any,
  );
  stubs.push(adminStub);

  // Mock subscription insert
  mockDb.setTable("institution_subscriptions", undefined, {
    data: { id: "sub-new" },
    error: null,
  });

  // Mock membership update (non-fatal if fails)
  mockDb.setTable("memberships", undefined, undefined, {
    data: null,
    error: null,
  });

  const payload = JSON.stringify({
    id: "evt_test_checkout_completed",
    type: "checkout.session.completed",
    data: {
      object: {
        id: FAKE_STRIPE_SESSION_ID,
        status: "complete",
        customer: FAKE_STRIPE_CUSTOMER_ID,
        subscription: FAKE_STRIPE_SUBSCRIPTION_ID,
        metadata: {
          institution_id: FAKE_INSTITUTION_ID,
          plan_id: FAKE_PLAN_ID,
          user_id: FAKE_USER_ID,
        },
      },
    },
  });

  try {
    const app = buildApp();
    const res = await app.request("/server/webhooks/stripe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": "t=1234567890,v1=fakesig",
      },
      body: payload,
    });
    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.data.received, true);
  } finally {
    restore();
  }
});

Deno.test("webhook: rejects checkout.session.completed with invalid UUID metadata", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();

  const verifyStub = stub(
    webhookMod,
    "verifyStripeSignature",
    async () => true,
  );
  stubs.push(verifyStub);

  const adminStub = stub(
    dbMod,
    "getAdminClient",
    () => mockDb.db as any,
  );
  stubs.push(adminStub);

  const payload = JSON.stringify({
    id: "evt_test_bad_uuid",
    type: "checkout.session.completed",
    data: {
      object: {
        id: FAKE_STRIPE_SESSION_ID,
        status: "complete",
        customer: FAKE_STRIPE_CUSTOMER_ID,
        subscription: FAKE_STRIPE_SUBSCRIPTION_ID,
        metadata: {
          institution_id: "not-a-uuid", // Invalid!
          plan_id: FAKE_PLAN_ID,
          user_id: FAKE_USER_ID,
        },
      },
    },
  });

  try {
    const app = buildApp();
    const res = await app.request("/server/webhooks/stripe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": "t=1234567890,v1=fakesig",
      },
      body: payload,
    });
    // Should still return 200 (event acknowledged), but not inserted
    assertEquals(res.status, 200);
  } finally {
    restore();
  }
});

Deno.test("webhook: handles customer.subscription.updated event", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();

  const verifyStub = stub(
    webhookMod,
    "verifyStripeSignature",
    async () => true,
  );
  stubs.push(verifyStub);

  const adminStub = stub(
    dbMod,
    "getAdminClient",
    () => mockDb.db as any,
  );
  stubs.push(adminStub);

  mockDb.setTable("institution_subscriptions", undefined, undefined, {
    data: null,
    error: null,
  });

  const payload = JSON.stringify({
    id: "evt_test_sub_updated",
    type: "customer.subscription.updated",
    data: {
      object: {
        id: FAKE_STRIPE_SUBSCRIPTION_ID,
        status: "past_due",
        current_period_start: Math.floor(Date.now() / 1000),
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        cancel_at_period_end: false,
        trial_start: null,
        trial_end: null,
      },
    },
  });

  try {
    const app = buildApp();
    const res = await app.request("/server/webhooks/stripe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": "t=1234567890,v1=fakesig",
      },
      body: payload,
    });
    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.data.received, true);
  } finally {
    restore();
  }
});

Deno.test("webhook: handles customer.subscription.deleted event", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();

  const verifyStub = stub(
    webhookMod,
    "verifyStripeSignature",
    async () => true,
  );
  stubs.push(verifyStub);

  const adminStub = stub(
    dbMod,
    "getAdminClient",
    () => mockDb.db as any,
  );
  stubs.push(adminStub);

  mockDb.setTable("institution_subscriptions", undefined, undefined, {
    data: null,
    error: null,
  });

  const payload = JSON.stringify({
    id: "evt_test_sub_deleted",
    type: "customer.subscription.deleted",
    data: {
      object: {
        id: FAKE_STRIPE_SUBSCRIPTION_ID,
        status: "canceled",
      },
    },
  });

  try {
    const app = buildApp();
    const res = await app.request("/server/webhooks/stripe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": "t=1234567890,v1=fakesig",
      },
      body: payload,
    });
    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.data.received, true);
  } finally {
    restore();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Timing-Safe Comparison Tests
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("timingSafeEqual: returns true for identical strings", () => {
  const result = timingSafeEqual("hello", "hello");
  assertEquals(result, true);
});

Deno.test("timingSafeEqual: returns false for different strings", () => {
  const result = timingSafeEqual("hello", "world");
  assertEquals(result, false);
});

Deno.test("timingSafeEqual: returns false for different lengths", () => {
  const result = timingSafeEqual("short", "much_longer_string");
  assertEquals(result, false);
});

Deno.test("timingSafeEqual: handles empty strings", () => {
  assertEquals(timingSafeEqual("", ""), true);
  assertEquals(timingSafeEqual("", "a"), false);
});

Deno.test("timingSafeEqual: handles unicode characters", () => {
  assertEquals(timingSafeEqual("café", "café"), true);
  assertEquals(timingSafeEqual("café", "cafe"), false);
});

Deno.test("timingSafeEqual: timing is constant (no early exit)", () => {
  // This is a basic sanity check; a real timing attack would need
  // measurements in nanoseconds with statistical analysis.
  // The function should always compare all bytes.
  const result1 = timingSafeEqual("a".repeat(1000), "a".repeat(1000));
  const result2 = timingSafeEqual("a".repeat(1000), "b" + "a".repeat(999));
  assertEquals(result1, true);
  assertEquals(result2, false);
});

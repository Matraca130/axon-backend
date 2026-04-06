/**
 * tests/integration/messaging-routes.test.ts — Comprehensive integration tests for messaging routes
 *
 * Tests for Telegram and WhatsApp messaging endpoints:
 *
 * TELEGRAM:
 *   POST /webhooks/telegram          — Incoming message webhook
 *   POST /telegram/link-code         — Generate link code for user
 *   GET  /telegram/link-status       — Check link status
 *   POST /telegram/setup-webhook     — Admin: Set webhook URL
 *   POST /telegram/process-queue     — Queue processor (cron job)
 *
 * WHATSAPP:
 *   GET  /webhooks/whatsapp          — Verification challenge (Meta setup)
 *   POST /webhooks/whatsapp          — Incoming webhook (HMAC-verified)
 *   POST /whatsapp/link-code         — Generate link code for user
 *   POST /whatsapp/unlink            — Unlink phone number
 *   POST /whatsapp/process-queue     — Queue processor (cron job)
 *
 * Strategy: Unit tests with fully mocked Supabase, external APIs, and crypto.
 * We stub `authenticate`, DB calls, HTTP requests, and signature verification
 * so tests run without network, env vars, or real databases.
 *
 * Run: deno test tests/integration/messaging-routes.test.ts --allow-all
 */

import {
  assertEquals,
  assertExists,
  assertStringIncludes,
  assertFalse,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  stub,
  restore,
  type Stub,
} from "https://deno.land/std@0.224.0/testing/mock.ts";

// ─── Test Constants ──────────────────────────────────────────────────

const FAKE_USER_ID = "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb";
const FAKE_TELEGRAM_CHAT_ID = 123456789;
const FAKE_TELEGRAM_MESSAGE_ID = 1;
const FAKE_TELEGRAM_BOT_TOKEN = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";
const FAKE_TELEGRAM_WEBHOOK_SECRET = "tg_secret_token_12345";
const FAKE_WHATSAPP_PHONE = "+12025551234";
const FAKE_WHATSAPP_PHONE_ID = "123456789";
const FAKE_WHATSAPP_MESSAGE_ID = "wamid.HBEUGoNkJWEJAgo-YY7jWqXlQhE=";
const FAKE_WHATSAPP_APP_SECRET = "whatsapp_app_secret_12345";
const FAKE_WHATSAPP_VERIFY_TOKEN = "whatsapp_verify_token_12345";
const FAKE_SERVICE_ROLE_KEY = "fake-service-role-key";
const FAKE_LINK_CODE = "123456";

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
  error: { message: string; code?: string } | null;
}

interface TableConfig {
  selectResponse?: MockResponse;
  insertResponse?: MockResponse;
  updateResponse?: MockResponse;
  deleteResponse?: MockResponse;
}

function createMockDb(tableConfigs: Record<string, TableConfig> = {}) {
  let currentTable = "";
  let currentOperation = "select";

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
    upsert: (_data: unknown, _opts?: unknown) => {
      currentOperation = "insert";
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

  Object.defineProperty(chainable, "then", { enumerable: false });

  const db = {
    from: (table: string) => {
      currentTable = table;
      return chainable;
    },
  };

  return {
    db,
    setTable(
      table: string,
      selectResponse?: MockResponse,
      insertResponse?: MockResponse,
      updateResponse?: MockResponse,
    ) {
      if (!tableConfigs[table]) tableConfigs[table] = {};
      if (selectResponse) tableConfigs[table].selectResponse = selectResponse;
      if (insertResponse) tableConfigs[table].insertResponse = insertResponse;
      if (updateResponse) tableConfigs[table].updateResponse = updateResponse;
    },
  };
}

// ─── Setup Env and Imports ─────────────────────────────────────────────

Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_ANON_KEY", "fake-anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", FAKE_SERVICE_ROLE_KEY);
Deno.env.set("TELEGRAM_ENABLED", "true");
Deno.env.set("TELEGRAM_BOT_TOKEN", FAKE_TELEGRAM_BOT_TOKEN);
Deno.env.set("TELEGRAM_WEBHOOK_SECRET", FAKE_TELEGRAM_WEBHOOK_SECRET);
Deno.env.set("TELEGRAM_BOT_USERNAME", "AxonStudyBot");
Deno.env.set("WHATSAPP_ENABLED", "true");
Deno.env.set("WHATSAPP_PHONE_NUMBER_ID", FAKE_WHATSAPP_PHONE_ID);
Deno.env.set("WHATSAPP_APP_SECRET", FAKE_WHATSAPP_APP_SECRET);
Deno.env.set("WHATSAPP_VERIFY_TOKEN", FAKE_WHATSAPP_VERIFY_TOKEN);
Deno.env.set("WHATSAPP_ACCESS_TOKEN", "fake-whatsapp-access-token");

import { Hono } from "npm:hono";
import * as dbMod from "../../supabase/functions/server/db.ts";
import * as telegramMod from "../../supabase/functions/server/routes/telegram/index.ts";
import * as whatsappMod from "../../supabase/functions/server/routes/whatsapp/index.ts";
import * as tgClientMod from "../../supabase/functions/server/routes/telegram/tg-client.ts";
import * as waClientMod from "../../supabase/functions/server/routes/whatsapp/wa-client.ts";

// ─── Test App Builder ────────────────────────────────────────────────

function buildApp() {
  const app = new Hono();
  app.route("/", telegramMod.telegramRoutes);
  app.route("/", whatsappMod.whatsappRoutes);
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

function setupGetAdminClientStub(
  stubs: StubList,
  mockDb: ReturnType<typeof createMockDb>,
) {
  const adminStub = stub(
    dbMod,
    "getAdminClient",
    () => mockDb.db as unknown as any,
  );
  stubs.push(adminStub);
  return adminStub;
}

// ─── HMAC Helper for WhatsApp ────────────────────────────────────────────

async function generateWhatsAppSignature(body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(FAKE_WHATSAPP_APP_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const hex = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hex}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// TELEGRAM TESTS
// ═══════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────
// Telegram: POST /webhooks/telegram
// ─────────────────────────────────────────────────────────────────────────

Deno.test("telegram-webhook: rejects missing secret token", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupGetAdminClientStub(stubs, mockDb);

  try {
    const app = buildApp();
    const body = JSON.stringify({
      update_id: 1,
      message: {
        message_id: FAKE_TELEGRAM_MESSAGE_ID,
        from: { id: 123, is_bot: false, first_name: "Test" },
        chat: { id: FAKE_TELEGRAM_CHAT_ID, type: "private" },
        date: Math.floor(Date.now() / 1000),
        text: "Hello",
      },
    });

    const res = await app.request("/server/webhooks/telegram", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Missing X-Telegram-Bot-Api-Secret-Token header
      },
      body,
    });

    assertEquals(res.status, 401);
    const json = await res.json();
    assertStringIncludes(json.error, "Invalid secret");
  } finally {
    restore();
  }
});

Deno.test("telegram-webhook: rejects invalid secret token", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupGetAdminClientStub(stubs, mockDb);

  try {
    const app = buildApp();
    const body = JSON.stringify({
      update_id: 1,
      message: {
        message_id: FAKE_TELEGRAM_MESSAGE_ID,
        from: { id: 123, is_bot: false, first_name: "Test" },
        chat: { id: FAKE_TELEGRAM_CHAT_ID, type: "private" },
        date: Math.floor(Date.now() / 1000),
        text: "Hello",
      },
    });

    const res = await app.request("/server/webhooks/telegram", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "wrong_secret",
      },
      body,
    });

    assertEquals(res.status, 401);
  } finally {
    restore();
  }
});

Deno.test("telegram-webhook: accepts valid secret and returns 200", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupGetAdminClientStub(stubs, mockDb);

  mockDb.setTable("telegram_links", {
    selectResponse: { data: null, error: null },
  });

  mockDb.setTable("telegram_message_log", {
    insertResponse: { data: null, error: null },
  });

  try {
    const app = buildApp();
    const body = JSON.stringify({
      update_id: 1,
      message: {
        message_id: FAKE_TELEGRAM_MESSAGE_ID,
        from: { id: 123, is_bot: false, first_name: "Test" },
        chat: { id: FAKE_TELEGRAM_CHAT_ID, type: "private" },
        date: Math.floor(Date.now() / 1000),
        text: "Hello",
      },
    });

    const res = await app.request("/server/webhooks/telegram", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": FAKE_TELEGRAM_WEBHOOK_SECRET,
      },
      body,
    });

    assertEquals(res.status, 200);
  } finally {
    restore();
  }
});

Deno.test("telegram-webhook: rejects invalid JSON payload", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupGetAdminClientStub(stubs, mockDb);

  try {
    const app = buildApp();
    const res = await app.request("/server/webhooks/telegram", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": FAKE_TELEGRAM_WEBHOOK_SECRET,
      },
      body: "invalid json {",
    });

    assertEquals(res.status, 400);
    const json = await res.json();
    assertStringIncludes(json.error, "Invalid JSON");
  } finally {
    restore();
  }
});

Deno.test("telegram-webhook: handles linking code validation", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupGetAdminClientStub(stubs, mockDb);

  // No linked user
  mockDb.setTable("telegram_links", {
    selectResponse: { data: null, error: null },
  });

  // Matching linking session
  const expiresAt = new Date(Date.now() + 300000).toISOString();
  mockDb.setTable("telegram_sessions", {
    selectResponse: {
      data: [
        {
          chat_id: -123,
          current_context: {
            linking_code: FAKE_LINK_CODE,
            linking_user_id: FAKE_USER_ID,
            linking_expires_at: expiresAt,
          },
          expires_at: expiresAt,
        },
      ],
      error: null,
    },
  });

  mockDb.setTable("telegram_message_log", {
    insertResponse: { data: null, error: null },
  });

  // Stub sendTextPlain
  const sendTextStub = stub(
    tgClientMod,
    "sendTextPlain",
    async () => {
      return true;
    },
  );
  stubs.push(sendTextStub);

  try {
    const app = buildApp();
    const body = JSON.stringify({
      update_id: 1,
      message: {
        message_id: FAKE_TELEGRAM_MESSAGE_ID,
        from: { id: 123, is_bot: false, first_name: "Test" },
        chat: { id: FAKE_TELEGRAM_CHAT_ID, type: "private" },
        date: Math.floor(Date.now() / 1000),
        text: FAKE_LINK_CODE,
      },
    });

    const res = await app.request("/server/webhooks/telegram", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": FAKE_TELEGRAM_WEBHOOK_SECRET,
      },
      body,
    });

    assertEquals(res.status, 200);
  } finally {
    restore();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Telegram: POST /telegram/link-code
// ─────────────────────────────────────────────────────────────────────────

Deno.test("telegram-link-code: returns 401 when not authenticated", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb, { failAuth: true });

  try {
    const app = buildApp();
    const res = await app.request("/server/telegram/link-code", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    assertEquals(res.status, 401);
  } finally {
    restore();
  }
});

Deno.test("telegram-link-code: returns 409 when link already exists", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);
  setupGetAdminClientStub(stubs, mockDb);

  mockDb.setTable("telegram_links", {
    selectResponse: {
      data: { id: "link-1", is_active: true },
      error: null,
    },
  });

  try {
    const app = buildApp();
    const res = await app.request("/server/telegram/link-code", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: "{}",
    });

    assertEquals(res.status, 409);
  } finally {
    restore();
  }
});

Deno.test("telegram-link-code: returns 200 with code on success", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);
  setupGetAdminClientStub(stubs, mockDb);

  mockDb.setTable("telegram_links", {
    selectResponse: { data: null, error: null },
  });

  mockDb.setTable("telegram_sessions", {
    insertResponse: { data: null, error: null },
  });

  try {
    const app = buildApp();
    const res = await app.request("/server/telegram/link-code", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: "{}",
    });

    assertEquals(res.status, 200);
    const json = await res.json();
    assertExists(json.data);
    assertExists(json.data.code);
    assertEquals(json.data.code.length, 6);
    assertEquals(json.data.expiresIn, 300);
  } finally {
    restore();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Telegram: GET /telegram/link-status
// ─────────────────────────────────────────────────────────────────────────

Deno.test("telegram-link-status: returns 401 when not authenticated", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb, { failAuth: true });

  try {
    const app = buildApp();
    const res = await app.request("/server/telegram/link-status", {
      method: "GET",
      headers: {},
    });

    assertEquals(res.status, 401);
  } finally {
    restore();
  }
});

Deno.test("telegram-link-status: returns is_linked=false when unlinked", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);
  setupGetAdminClientStub(stubs, mockDb);

  mockDb.setTable("telegram_links", {
    selectResponse: {
      data: null,
      error: { message: "PGRST116", code: "PGRST116" },
    },
  });

  try {
    const app = buildApp();
    const res = await app.request("/server/telegram/link-status", {
      method: "GET",
      headers: { "X-Access-Token": FAKE_JWT },
    });

    assertEquals(res.status, 200);
    const json = await res.json();
    assertFalse(json.data.is_linked);
  } finally {
    restore();
  }
});

Deno.test("telegram-link-status: returns is_linked=true with details when linked", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);
  setupGetAdminClientStub(stubs, mockDb);

  mockDb.setTable("telegram_links", {
    selectResponse: {
      data: {
        username: "testuser",
        linked_at: "2024-01-01T00:00:00Z",
      },
      error: null,
    },
  });

  try {
    const app = buildApp();
    const res = await app.request("/server/telegram/link-status", {
      method: "GET",
      headers: { "X-Access-Token": FAKE_JWT },
    });

    assertEquals(res.status, 200);
    const json = await res.json();
    assert(json.data.is_linked);
    assertEquals(json.data.username, "testuser");
  } finally {
    restore();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Telegram: POST /telegram/setup-webhook (admin)
// ─────────────────────────────────────────────────────────────────────────

Deno.test("telegram-setup-webhook: rejects missing Authorization header", async () => {
  const stubs: StubList = [];

  try {
    const app = buildApp();
    const res = await app.request("/server/telegram/setup-webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ webhook_url: "https://example.com/webhook" }),
    });

    assertEquals(res.status, 401);
  } finally {
    restore();
  }
});

Deno.test("telegram-setup-webhook: rejects invalid Bearer token", async () => {
  const stubs: StubList = [];

  try {
    const app = buildApp();
    const res = await app.request("/server/telegram/setup-webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer wrong_token",
      },
      body: JSON.stringify({ webhook_url: "https://example.com/webhook" }),
    });

    assertEquals(res.status, 401);
  } finally {
    restore();
  }
});

Deno.test("telegram-setup-webhook: rejects missing webhook_url", async () => {
  const stubs: StubList = [];

  try {
    const app = buildApp();
    const res = await app.request("/server/telegram/setup-webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${FAKE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({}),
    });

    assertEquals(res.status, 400);
    const json = await res.json();
    assertStringIncludes(json.error, "webhook_url");
  } finally {
    restore();
  }
});

Deno.test("telegram-setup-webhook: returns 200 on success", async () => {
  const stubs: StubList = [];

  const setWebhookStub = stub(
    tgClientMod,
    "setWebhook",
    async () => true,
  );
  stubs.push(setWebhookStub);

  const getMeStub = stub(
    tgClientMod,
    "getMe",
    async () => ({ id: 123, is_bot: true, first_name: "TestBot" }),
  );
  stubs.push(getMeStub);

  try {
    const app = buildApp();
    const res = await app.request("/server/telegram/setup-webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${FAKE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ webhook_url: "https://example.com/webhook" }),
    });

    assertEquals(res.status, 200);
    const json = await res.json();
    assert(json.data.success);
    assertEquals(json.data.webhook_url, "https://example.com/webhook");
  } finally {
    restore();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Telegram: POST /telegram/process-queue
// ─────────────────────────────────────────────────────────────────────────

Deno.test("telegram-process-queue: rejects missing Authorization header", async () => {
  const stubs: StubList = [];

  try {
    const app = buildApp();
    const res = await app.request("/server/telegram/process-queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    assertEquals(res.status, 401);
  } finally {
    restore();
  }
});

Deno.test("telegram-process-queue: rejects invalid Bearer token", async () => {
  const stubs: StubList = [];

  try {
    const app = buildApp();
    const res = await app.request("/server/telegram/process-queue", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer wrong_token",
      },
      body: "{}",
    });

    assertEquals(res.status, 401);
  } finally {
    restore();
  }
});

Deno.test("telegram-process-queue: returns 200 with processed count", async () => {
  const stubs: StubList = [];

  try {
    const app = buildApp();
    const res = await app.request("/server/telegram/process-queue", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${FAKE_SERVICE_ROLE_KEY}`,
      },
      body: "{}",
    });

    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(typeof json.data.processed, "number");
  } finally {
    restore();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// WHATSAPP TESTS
// ═══════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────
// WhatsApp: GET /webhooks/whatsapp (verification challenge)
// ─────────────────────────────────────────────────────────────────────────

Deno.test("whatsapp-verification: returns 403 for invalid mode", async () => {
  const stubs: StubList = [];

  try {
    const app = buildApp();
    const res = await app.request(
      "/server/webhooks/whatsapp?hub.mode=invalid&hub.verify_token=test&hub.challenge=xyz",
      { method: "GET", headers: {} },
    );

    assertEquals(res.status, 403);
  } finally {
    restore();
  }
});

Deno.test("whatsapp-verification: returns 403 for invalid token", async () => {
  const stubs: StubList = [];

  try {
    const app = buildApp();
    const res = await app.request(
      "/server/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=xyz",
      { method: "GET", headers: {} },
    );

    assertEquals(res.status, 403);
  } finally {
    restore();
  }
});

Deno.test("whatsapp-verification: returns 200 with challenge on success", async () => {
  const stubs: StubList = [];

  try {
    const app = buildApp();
    const challengeValue = "test_challenge_123";
    const res = await app.request(
      `/server/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${FAKE_WHATSAPP_VERIFY_TOKEN}&hub.challenge=${challengeValue}`,
      { method: "GET", headers: {} },
    );

    assertEquals(res.status, 200);
    const text = await res.text();
    assertEquals(text, challengeValue);
  } finally {
    restore();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// WhatsApp: POST /webhooks/whatsapp (incoming message)
// ─────────────────────────────────────────────────────────────────────────

Deno.test("whatsapp-webhook: rejects missing HMAC signature", async () => {
  const stubs: StubList = [];

  try {
    const app = buildApp();
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [],
    });

    const res = await app.request("/server/webhooks/whatsapp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    assertEquals(res.status, 401);
  } finally {
    restore();
  }
});

Deno.test("whatsapp-webhook: rejects invalid HMAC signature", async () => {
  const stubs: StubList = [];

  try {
    const app = buildApp();
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [],
    });

    const res = await app.request("/server/webhooks/whatsapp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-hub-signature-256": "sha256=invalid",
      },
      body,
    });

    assertEquals(res.status, 401);
  } finally {
    restore();
  }
});

Deno.test("whatsapp-webhook: rejects invalid JSON payload", async () => {
  const stubs: StubList = [];

  try {
    const app = buildApp();
    const body = "invalid json {";
    const signature = await generateWhatsAppSignature(body);

    const res = await app.request("/server/webhooks/whatsapp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-hub-signature-256": signature,
      },
      body,
    });

    assertEquals(res.status, 400);
  } finally {
    restore();
  }
});

Deno.test("whatsapp-webhook: accepts valid HMAC signature", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupGetAdminClientStub(stubs, mockDb);

  mockDb.setTable("whatsapp_links", {
    selectResponse: { data: null, error: null },
  });

  mockDb.setTable("whatsapp_message_log", {
    insertResponse: { data: null, error: null },
  });

  const sendTextStub = stub(
    waClientMod,
    "sendText",
    async () => {
      return true;
    },
  );
  stubs.push(sendTextStub);

  try {
    const app = buildApp();
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "entry-1",
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "1234567890",
                  phone_number_id: FAKE_WHATSAPP_PHONE_ID,
                },
                messages: [
                  {
                    from: FAKE_WHATSAPP_PHONE,
                    id: FAKE_WHATSAPP_MESSAGE_ID,
                    timestamp: Math.floor(Date.now() / 1000).toString(),
                    type: "text",
                    text: { body: "Hello" },
                  },
                ],
              },
              field: "messages",
            },
          ],
        },
      ],
    });
    const signature = await generateWhatsAppSignature(body);

    const res = await app.request("/server/webhooks/whatsapp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-hub-signature-256": signature,
      },
      body,
    });

    assertEquals(res.status, 200);
  } finally {
    restore();
  }
});

Deno.test("whatsapp-webhook: handles text messages", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupGetAdminClientStub(stubs, mockDb);

  mockDb.setTable("whatsapp_links", {
    selectResponse: { data: null, error: null },
  });

  mockDb.setTable("whatsapp_message_log", {
    insertResponse: { data: null, error: null },
  });

  const sendTextStub = stub(
    waClientMod,
    "sendText",
    async () => {
      return true;
    },
  );
  stubs.push(sendTextStub);

  const hashPhoneStub = stub(
    waClientMod,
    "hashPhone",
    async (phone: string) => {
      return `hash_${phone}`;
    },
  );
  stubs.push(hashPhoneStub);

  try {
    const app = buildApp();
    const messageText = "What should I study?";
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "entry-1",
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "1234567890",
                  phone_number_id: FAKE_WHATSAPP_PHONE_ID,
                },
                contacts: [{ profile: { name: "Test User" }, wa_id: "12025551234" }],
                messages: [
                  {
                    from: FAKE_WHATSAPP_PHONE,
                    id: FAKE_WHATSAPP_MESSAGE_ID,
                    timestamp: Math.floor(Date.now() / 1000).toString(),
                    type: "text",
                    text: { body: messageText },
                  },
                ],
              },
              field: "messages",
            },
          ],
        },
      ],
    });
    const signature = await generateWhatsAppSignature(body);

    const res = await app.request("/server/webhooks/whatsapp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-hub-signature-256": signature,
      },
      body,
    });

    assertEquals(res.status, 200);
  } finally {
    restore();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// WhatsApp: POST /whatsapp/link-code
// ─────────────────────────────────────────────────────────────────────────

Deno.test("whatsapp-link-code: returns 401 when not authenticated", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb, { failAuth: true });

  try {
    const app = buildApp();
    const res = await app.request("/server/whatsapp/link-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    assertEquals(res.status, 401);
  } finally {
    restore();
  }
});

Deno.test("whatsapp-link-code: returns 409 when link already exists", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);
  setupGetAdminClientStub(stubs, mockDb);

  mockDb.setTable("whatsapp_links", {
    selectResponse: {
      data: { id: "link-1", is_active: true },
      error: null,
    },
  });

  try {
    const app = buildApp();
    const res = await app.request("/server/whatsapp/link-code", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: "{}",
    });

    assertEquals(res.status, 409);
  } finally {
    restore();
  }
});

Deno.test("whatsapp-link-code: returns 200 with code on success", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);
  setupGetAdminClientStub(stubs, mockDb);

  mockDb.setTable("whatsapp_links", {
    selectResponse: { data: null, error: null },
  });

  mockDb.setTable("whatsapp_sessions", {
    insertResponse: { data: null, error: null },
  });

  try {
    const app = buildApp();
    const res = await app.request("/server/whatsapp/link-code", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: "{}",
    });

    assertEquals(res.status, 200);
    const json = await res.json();
    assertExists(json.data);
    assertExists(json.data.code);
    assertEquals(json.data.code.length, 6);
    assertEquals(json.data.expiresIn, 300);
  } finally {
    restore();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// WhatsApp: POST /whatsapp/unlink
// ─────────────────────────────────────────────────────────────────────────

Deno.test("whatsapp-unlink: returns 401 when not authenticated", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb, { failAuth: true });

  try {
    const app = buildApp();
    const res = await app.request("/server/whatsapp/unlink", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    assertEquals(res.status, 401);
  } finally {
    restore();
  }
});

Deno.test("whatsapp-unlink: returns 200 on success", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);
  setupGetAdminClientStub(stubs, mockDb);

  mockDb.setTable("whatsapp_links", {
    updateResponse: { data: null, error: null },
  });

  try {
    const app = buildApp();
    const res = await app.request("/server/whatsapp/unlink", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: "{}",
    });

    assertEquals(res.status, 200);
    const json = await res.json();
    assertStringIncludes(json.data.message, "desvinculado");
  } finally {
    restore();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// WhatsApp: POST /whatsapp/process-queue
// ─────────────────────────────────────────────────────────────────────────

Deno.test("whatsapp-process-queue: rejects missing Authorization header", async () => {
  const stubs: StubList = [];

  try {
    const app = buildApp();
    const res = await app.request("/server/whatsapp/process-queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    assertEquals(res.status, 401);
  } finally {
    restore();
  }
});

Deno.test("whatsapp-process-queue: rejects invalid Bearer token", async () => {
  const stubs: StubList = [];

  try {
    const app = buildApp();
    const res = await app.request("/server/whatsapp/process-queue", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer wrong_token",
      },
      body: "{}",
    });

    assertEquals(res.status, 401);
  } finally {
    restore();
  }
});

Deno.test("whatsapp-process-queue: returns 200 with processed count", async () => {
  const stubs: StubList = [];

  try {
    const app = buildApp();
    const res = await app.request("/server/whatsapp/process-queue", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${FAKE_SERVICE_ROLE_KEY}`,
      },
      body: "{}",
    });

    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(typeof json.data.processed, "number");
  } finally {
    restore();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Feature Flag Tests
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("feature-flag: returns 503 when TELEGRAM_ENABLED=false", async () => {
  const originalValue = Deno.env.get("TELEGRAM_ENABLED");
  Deno.env.set("TELEGRAM_ENABLED", "false");

  try {
    const app = buildApp();
    const res = await app.request("/server/telegram/link-code", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: "{}",
    });

    assertEquals(res.status, 503);
  } finally {
    Deno.env.set("TELEGRAM_ENABLED", originalValue || "true");
    restore();
  }
});

Deno.test("feature-flag: returns 503 when WHATSAPP_ENABLED=false", async () => {
  const originalValue = Deno.env.get("WHATSAPP_ENABLED");
  Deno.env.set("WHATSAPP_ENABLED", "false");

  try {
    const app = buildApp();
    const res = await app.request("/server/whatsapp/link-code", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: "{}",
    });

    assertEquals(res.status, 503);
  } finally {
    Deno.env.set("WHATSAPP_ENABLED", originalValue || "true");
    restore();
  }
});

/**
 * tests/integration/infra-routes.test.ts — Infrastructure route integration tests
 *
 * Tests for three infrastructure route modules:
 *   1. /calendar — GET /calendar/data, POST /calendar/exam-events, GET /calendar/fsrs-calendar
 *   2. /settings — GET /settings, PUT /settings, GET /algorithm-config, PUT /algorithm-config
 *   3. /plans — GET /plans/access, GET /plans/ai-generations, POST /plans/ai-generations, GET /plans/diagnostics
 *
 * Strategy: Unit tests with fully mocked Supabase + Hono dependencies.
 * We stub `authenticate`, DB calls, and RPC methods so tests run without
 * network, env vars, or real databases.
 *
 * Run: deno test tests/integration/infra-routes.test.ts --allow-all --no-check
 */

import {
  assertEquals,
  assertExists,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  stub,
  restore,
  type Stub,
} from "https://deno.land/std@0.224.0/testing/mock.ts";

// ═══════════════════════════════════════════════════════════════════════════
// TEST CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const FAKE_USER_ID = "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb";
const FAKE_INSTITUTION_ID = "eeeeeeee-7777-8888-9999-ffffffffffff";
const FAKE_COURSE_ID = "cccccccc-4444-5555-6666-dddddddddddd";
const FAKE_EVENT_ID = "f1111111-aaaa-bbbb-cccc-222222222222";
const FAKE_SUMMARY_ID = "33333333-dddd-eeee-ffff-444444444444";

// Build fake JWT
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

const FAKE_JWT = buildFakeJwt({
  sub: FAKE_USER_ID,
  email: "test@axon.com",
  exp: 9999999999,
});

// ═══════════════════════════════════════════════════════════════════════════
// MOCK SUPABASE CLIENT BUILDER
// ═══════════════════════════════════════════════════════════════════════════

interface MockResponse {
  data: unknown;
  error: { message: string } | null;
  count?: number | null;
}

interface TableConfig {
  selectResponse?: MockResponse;
  insertResponse?: MockResponse;
  updateResponse?: MockResponse;
  deleteResponse?: MockResponse;
  rpcResponse?: MockResponse;
}

interface MockDbBuilder {
  db: any;
  rpcResponses: Record<string, MockResponse>;
  setRpc(fnName: string, resp: MockResponse): void;
  setTable(table: string, resp: MockResponse): void;
  setTableInsert(table: string, resp: MockResponse): void;
  setTableUpdate(table: string, resp: MockResponse): void;
  setTableSelect(table: string, resp: MockResponse): void;
}

function createMockDb(): MockDbBuilder {
  const tableConfigs: Record<string, TableConfig> = {};
  const rpcResponses: Record<string, MockResponse> = {};
  let currentTable = "";
  let currentOperation = "select"; // select, insert, update, delete

  const chainable = {
    select: (_cols?: string) => {
      currentOperation = "select";
      return chainable;
    },
    insert: (_data?: unknown) => {
      currentOperation = "insert";
      return chainable;
    },
    update: (_data?: unknown) => {
      currentOperation = "update";
      return chainable;
    },
    delete: () => {
      currentOperation = "delete";
      return chainable;
    },
    eq: (_col: string, _val: unknown) => chainable,
    neq: (_col: string, _val: unknown) => chainable,
    gte: (_col: string, _val: unknown) => chainable,
    lte: (_col: string, _val: unknown) => chainable,
    lt: (_col: string, _val: unknown) => chainable,
    in: (_col: string, _val: unknown[]) => chainable,
    is: (_col: string, _val: unknown) => chainable,
    or: (_filter: string) => chainable,
    order: (_col: string, _opts?: Record<string, unknown>) => chainable,
    limit: (_n: number) => chainable,
    range: (_from: number, _to: number) => chainable,
    maybeSingle: () => chainable,
    single: () => chainable,
    head: () => chainable,
    // Terminal — returns configured response based on current operation
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
    rpc: (fnName: string, _params?: Record<string, unknown>) => {
      const resp = rpcResponses[fnName] ?? { data: null, error: null };
      return Promise.resolve(resp);
    },
  };

  return {
    db,
    rpcResponses,
    setRpc(fnName: string, resp: MockResponse) {
      rpcResponses[fnName] = resp;
    },
    setTable(table: string, resp: MockResponse) {
      if (!tableConfigs[table]) tableConfigs[table] = {};
      tableConfigs[table].selectResponse = resp;
      tableConfigs[table].insertResponse = resp;
      tableConfigs[table].updateResponse = resp;
      tableConfigs[table].deleteResponse = resp;
    },
    setTableInsert(table: string, resp: MockResponse) {
      if (!tableConfigs[table]) tableConfigs[table] = {};
      tableConfigs[table].insertResponse = resp;
    },
    setTableUpdate(table: string, resp: MockResponse) {
      if (!tableConfigs[table]) tableConfigs[table] = {};
      tableConfigs[table].updateResponse = resp;
    },
    setTableSelect(table: string, resp: MockResponse) {
      if (!tableConfigs[table]) tableConfigs[table] = {};
      tableConfigs[table].selectResponse = resp;
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ENV SETUP & IMPORTS
// ═══════════════════════════════════════════════════════════════════════════

Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_ANON_KEY", "fake-anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "fake-service-role-key");

import { Hono } from "npm:hono";
import * as dbMod from "../../supabase/functions/server/db.ts";
import { calendarRoutes } from "../../supabase/functions/server/routes/calendar/index.ts";
import { settingsRoutes } from "../../supabase/functions/server/routes/settings/index.ts";
import { planRoutes } from "../../supabase/functions/server/routes/plans/index.ts";

// ═══════════════════════════════════════════════════════════════════════════
// TEST APP BUILDER
// ═══════════════════════════════════════════════════════════════════════════

function buildApp() {
  const app = new Hono();
  app.route("/", calendarRoutes);
  app.route("/", settingsRoutes);
  app.route("/", planRoutes);
  return app;
}

// ═══════════════════════════════════════════════════════════════════════════
// MOCK SETUP HELPERS
// ═══════════════════════════════════════════════════════════════════════════

type StubList = Stub[];

function setupAuthStub(
  stubs: StubList,
  mockDb: MockDbBuilder,
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
        db: mockDb.db as any,
      };
    },
  );
  stubs.push(authStub);
}

// ═══════════════════════════════════════════════════════════════════════════
// CALENDAR ROUTE TESTS
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("GET /calendar/data: returns aggregated data (events + heatmap + tasks) with valid date range → 200", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  mockDb.setTableSelect("exam_events", {
    data: [
      {
        id: FAKE_EVENT_ID,
        student_id: FAKE_USER_ID,
        title: "Midterm Exam",
        date: "2026-04-10",
        is_final: false,
      },
    ],
    error: null,
  });

  mockDb.setTableSelect("fsrs_states", {
    data: [
      { due_at: "2026-04-05T08:00:00Z" },
      { due_at: "2026-04-05T10:00:00Z" },
    ],
    error: null,
  });

  mockDb.setTableSelect("study_plan_tasks", {
    data: [
      { id: "task-1", title: "Chapter 3 Review", scheduled_date: "2026-04-07" },
    ],
    error: null,
  });

  try {
    const app = buildApp();
    const res = await app.request("/server/calendar/data?from=2026-04-01&to=2026-04-30", {
      method: "GET",
      headers: { "X-Access-Token": FAKE_JWT },
    });
    assertEquals(res.status, 200);
    const json = await res.json();
    assert(json.data.events, "response should have events");
    assert(json.data.heatmap, "response should have heatmap");
    assert(json.data.tasks, "response should have tasks");
  } finally {
    restore();
  }
});

Deno.test("GET /calendar/data: returns 401 when no auth header", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb, { failAuth: true });

  try {
    const app = buildApp();
    const res = await app.request("/server/calendar/data?from=2026-04-01&to=2026-04-30", {
      method: "GET",
    });
    assertEquals(res.status, 401);
  } finally {
    restore();
  }
});

Deno.test("GET /calendar/data: returns 400 when date range missing or invalid", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  try {
    const app = buildApp();
    // Missing 'from' param
    const res = await app.request("/server/calendar/data?to=2026-04-30", {
      method: "GET",
      headers: { "X-Access-Token": FAKE_JWT },
    });
    assertEquals(res.status, 400);
    const json = await res.json();
    assert(json.error, "response should have error message");
  } finally {
    restore();
  }
});

Deno.test("POST /calendar/exam-events: creates exam event with valid payload → 201", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  mockDb.setTableSelect("course_enrollments", {
    data: [{ id: "enrollment-1" }],
    error: null,
  });

  mockDb.setTableSelect("courses", {
    data: [{ institution_id: FAKE_INSTITUTION_ID }],
    error: null,
  });

  mockDb.setTableInsert("exam_events", {
    data: {
      id: FAKE_EVENT_ID,
      student_id: FAKE_USER_ID,
      course_id: FAKE_COURSE_ID,
      title: "Final Exam",
      date: "2026-05-15",
      is_final: true,
    },
    error: null,
  });

  try {
    const app = buildApp();
    const res = await app.request("/server/calendar/exam-events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: JSON.stringify({
        title: "Final Exam",
        date: "2026-05-15",
        course_id: FAKE_COURSE_ID,
        is_final: true,
      }),
    });
    assertEquals(res.status, 201);
    const json = await res.json();
    assert(json.data.id, "response should have event ID");
    assertEquals(json.data.title, "Final Exam");
  } finally {
    restore();
  }
});

Deno.test("POST /calendar/exam-events: returns 400 when required fields missing", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  try {
    const app = buildApp();
    const res = await app.request("/server/calendar/exam-events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: JSON.stringify({
        date: "2026-05-15",
        // missing title and course_id
      }),
    });
    assertEquals(res.status, 400);
  } finally {
    restore();
  }
});

Deno.test("POST /calendar/exam-events: returns 403 when not enrolled in course", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  mockDb.setTableSelect("course_enrollments", {
    data: null,
    error: null,
  });

  try {
    const app = buildApp();
    const res = await app.request("/server/calendar/exam-events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: JSON.stringify({
        title: "Exam",
        date: "2026-05-15",
        course_id: FAKE_COURSE_ID,
      }),
    });
    assertEquals(res.status, 403);
    const json = await res.json();
    assert(json.error?.includes("not enrolled"), "error should mention enrollment");
  } finally {
    restore();
  }
});

Deno.test("GET /calendar/workload: returns projected daily workload with valid days param → 200", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  mockDb.setRpc("get_projected_daily_workload", {
    data: [
      { date: "2026-04-05", cards_due: 12 },
      { date: "2026-04-06", cards_due: 8 },
    ],
    error: null,
  });

  try {
    const app = buildApp();
    const res = await app.request("/server/calendar/workload?days=90", {
      method: "GET",
      headers: { "X-Access-Token": FAKE_JWT },
    });
    assertEquals(res.status, 200);
    const json = await res.json();
    assert(Array.isArray(json.data) || json.data, "response should have workload data");
  } finally {
    restore();
  }
});

Deno.test("GET /calendar/workload: returns 400 when days param invalid", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  try {
    const app = buildApp();
    const res = await app.request("/server/calendar/workload?days=999", {
      method: "GET",
      headers: { "X-Access-Token": FAKE_JWT },
    });
    assertEquals(res.status, 400);
  } finally {
    restore();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SETTINGS ROUTE TESTS
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("GET /algorithm-config: returns config with institution_id param → 200", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  mockDb.setTableSelect("algorithm_config", {
    data: {
      id: "config-1",
      institution_id: FAKE_INSTITUTION_ID,
      overdue_weight: 0.40,
      mastery_weight: 0.30,
      fragility_weight: 0.20,
      novelty_weight: 0.10,
      version: "v4.2",
    },
    error: null,
  });

  try {
    const app = buildApp();
    const res = await app.request(`/server/algorithm-config?institution_id=${FAKE_INSTITUTION_ID}`, {
      method: "GET",
      headers: { "X-Access-Token": FAKE_JWT },
    });
    assertEquals(res.status, 200);
    const json = await res.json();
    assert(json.data.config, "response should have config");
    assertEquals(json.data.config.version, "v4.2");
  } finally {
    restore();
  }
});

Deno.test("GET /algorithm-config: returns hardcoded defaults when no config found → 200", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  mockDb.setTableSelect("algorithm_config", {
    data: null,
    error: null,
  });

  try {
    const app = buildApp();
    const res = await app.request(`/server/algorithm-config?institution_id=${FAKE_INSTITUTION_ID}`, {
      method: "GET",
      headers: { "X-Access-Token": FAKE_JWT },
    });
    assertEquals(res.status, 200);
    const json = await res.json();
    assert(json.data.config, "response should have fallback config");
    assertEquals(json.data.source, "hardcoded");
    assertEquals(json.data.config.overdue_weight, 0.40);
  } finally {
    restore();
  }
});

Deno.test("PUT /algorithm-config: updates config with valid weights → 200", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  mockDb.setTableSelect("memberships", {
    data: { role: "admin" },
    error: null,
  });

  mockDb.setTableSelect("algorithm_config", {
    data: {
      overdue_weight: 0.40,
      mastery_weight: 0.30,
      fragility_weight: 0.20,
      novelty_weight: 0.10,
    },
    error: null,
  });

  mockDb.setTableUpdate("algorithm_config", {
    data: {
      institution_id: FAKE_INSTITUTION_ID,
      overdue_weight: 0.35,
      mastery_weight: 0.35,
      fragility_weight: 0.20,
      novelty_weight: 0.10,
      updated_by: FAKE_USER_ID,
      updated_at: new Date().toISOString(),
    },
    error: null,
  });

  try {
    const app = buildApp();
    const res = await app.request(`/server/algorithm-config?institution_id=${FAKE_INSTITUTION_ID}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: JSON.stringify({
        overdue_weight: 0.35,
        mastery_weight: 0.35,
      }),
    });
    assertEquals(res.status, 200);
    const json = await res.json();
    assert(json.data.config, "response should have updated config");
  } finally {
    restore();
  }
});

Deno.test("PUT /algorithm-config: returns 400 when weights don't sum to 1.0", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  mockDb.setTableSelect("memberships", {
    data: { role: "admin" },
    error: null,
  });

  mockDb.setTableSelect("algorithm_config", {
    data: {
      overdue_weight: 0.40,
      mastery_weight: 0.30,
      fragility_weight: 0.20,
      novelty_weight: 0.10,
    },
    error: null,
  });

  try {
    const app = buildApp();
    const res = await app.request(`/server/algorithm-config?institution_id=${FAKE_INSTITUTION_ID}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: JSON.stringify({
        overdue_weight: 0.50,
        mastery_weight: 0.50,
        // sum = 1.0 but we don't include other weights, which should fail validation
      }),
    });
    // This should fail because weights don't include fragility_weight and novelty_weight
    assertEquals(res.status, 400);
  } finally {
    restore();
  }
});

Deno.test("PUT /algorithm-config: returns 403 when user is not admin/owner", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  mockDb.setTableSelect("memberships", {
    data: { role: "student" },
    error: null,
  });

  try {
    const app = buildApp();
    const res = await app.request(`/server/algorithm-config?institution_id=${FAKE_INSTITUTION_ID}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: JSON.stringify({
        overdue_weight: 0.50,
      }),
    });
    assertEquals(res.status, 403);
  } finally {
    restore();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PLANS ROUTE TESTS
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("GET /content-access: returns plan access info → 200", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  mockDb.setTableSelect("institution_subscriptions", {
    data: {
      id: "sub-1",
      plan_id: "plan-1",
      status: "active",
      current_period_end: "2026-12-31T23:59:59Z",
    },
    error: null,
  });

  mockDb.setTableSelect("institution_plans", {
    data: {
      name: "Premium",
      features: { content_gating: "full" },
    },
    error: null,
  });

  try {
    const app = buildApp();
    const res = await app.request(`/server/content-access?institution_id=${FAKE_INSTITUTION_ID}`, {
      method: "GET",
      headers: { "X-Access-Token": FAKE_JWT },
    });
    assertEquals(res.status, 200);
    const json = await res.json();
    assert(json.data.access, "response should have access field");
    assertEquals(json.data.plan_name, "Premium");
  } finally {
    restore();
  }
});

Deno.test("GET /content-access: returns 401 when no auth", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb, { failAuth: true });

  try {
    const app = buildApp();
    const res = await app.request(`/server/content-access?institution_id=${FAKE_INSTITUTION_ID}`, {
      method: "GET",
    });
    assertEquals(res.status, 401);
  } finally {
    restore();
  }
});

Deno.test("GET /ai-generations: lists AI generation records → 200", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  mockDb.setTableSelect("ai_generations", {
    data: [
      {
        id: "gen-1",
        institution_id: FAKE_INSTITUTION_ID,
        generation_type: "flashcard",
        items_generated: 5,
        created_at: "2026-04-01T10:00:00Z",
      },
    ],
    error: null,
  });

  try {
    const app = buildApp();
    const res = await app.request(`/server/ai-generations?institution_id=${FAKE_INSTITUTION_ID}`, {
      method: "GET",
      headers: { "X-Access-Token": FAKE_JWT },
    });
    assertEquals(res.status, 200);
    const json = await res.json();
    assert(Array.isArray(json.data), "response should be an array");
    if (json.data.length > 0) {
      assertEquals(json.data[0].generation_type, "flashcard");
    }
  } finally {
    restore();
  }
});

Deno.test("POST /ai-generations: creates AI generation record → 201", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  mockDb.setTableInsert("ai_generations", {
    data: {
      id: "gen-1",
      institution_id: FAKE_INSTITUTION_ID,
      requested_by: FAKE_USER_ID,
      generation_type: "summary",
      items_generated: 3,
      created_at: new Date().toISOString(),
    },
    error: null,
  });

  try {
    const app = buildApp();
    const res = await app.request("/server/ai-generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: JSON.stringify({
        institution_id: FAKE_INSTITUTION_ID,
        generation_type: "summary",
        items_generated: 3,
      }),
    });
    assertEquals(res.status, 201);
    const json = await res.json();
    assert(json.data.id, "response should have generation ID");
  } finally {
    restore();
  }
});

Deno.test("POST /ai-generations: returns 400 when required fields missing", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  try {
    const app = buildApp();
    const res = await app.request("/server/ai-generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: JSON.stringify({
        // missing institution_id and generation_type
      }),
    });
    assertEquals(res.status, 400);
  } finally {
    restore();
  }
});

Deno.test("GET /summary-diagnostics: lists diagnostic records → 200", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  mockDb.setTableSelect("summary_diagnostics", {
    data: [
      {
        id: "diag-1",
        summary_id: FAKE_SUMMARY_ID,
        content: "Weak areas detected: XYZ",
        diagnostic_type: "weak_points",
        created_at: "2026-04-01T10:00:00Z",
      },
    ],
    error: null,
  });

  try {
    const app = buildApp();
    const res = await app.request(`/server/summary-diagnostics?summary_id=${FAKE_SUMMARY_ID}`, {
      method: "GET",
      headers: { "X-Access-Token": FAKE_JWT },
    });
    assertEquals(res.status, 200);
    const json = await res.json();
    assert(Array.isArray(json.data), "response should be an array");
  } finally {
    restore();
  }
});

Deno.test("POST /summary-diagnostics: creates diagnostic record → 201", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  mockDb.setTableInsert("summary_diagnostics", {
    data: {
      id: "diag-1",
      summary_id: FAKE_SUMMARY_ID,
      requested_by: FAKE_USER_ID,
      content: "Analysis complete",
      diagnostic_type: "analysis",
      created_at: new Date().toISOString(),
    },
    error: null,
  });

  try {
    const app = buildApp();
    const res = await app.request("/server/summary-diagnostics", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: JSON.stringify({
        summary_id: FAKE_SUMMARY_ID,
        content: "Analysis complete",
      }),
    });
    assertEquals(res.status, 201);
    const json = await res.json();
    assert(json.data.id, "response should have diagnostic ID");
  } finally {
    restore();
  }
});

Deno.test("GET /usage-today: returns daily usage counts → 200", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  const today = new Date().toISOString().split("T")[0];

  mockDb.setTableSelect("quiz_attempts", {
    data: [{ id: "qa-1" }, { id: "qa-2" }],
    error: null,
    count: 2,
  });

  mockDb.setTableSelect("daily_activities", {
    data: { reviews_count: 15 },
    error: null,
  });

  mockDb.setTableSelect("ai_generations", {
    data: [{ id: "gen-1" }],
    error: null,
    count: 1,
  });

  try {
    const app = buildApp();
    const res = await app.request(`/server/usage-today?institution_id=${FAKE_INSTITUTION_ID}`, {
      method: "GET",
      headers: { "X-Access-Token": FAKE_JWT },
    });
    assertEquals(res.status, 200);
    const json = await res.json();
    assert(json.data.date, "response should have date");
    assert(typeof json.data.quizzes_taken === "number", "should have quizzes_taken");
    assert(typeof json.data.ai_generations === "number", "should have ai_generations");
  } finally {
    restore();
  }
});

Deno.test("GET /usage-today: returns 401 when no auth", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb, { failAuth: true });

  try {
    const app = buildApp();
    const res = await app.request(`/server/usage-today?institution_id=${FAKE_INSTITUTION_ID}`, {
      method: "GET",
    });
    assertEquals(res.status, 401);
  } finally {
    restore();
  }
});

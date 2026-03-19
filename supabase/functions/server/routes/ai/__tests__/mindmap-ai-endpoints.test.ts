/**
 * mindmap-ai-endpoints.test.ts
 *
 * Tests for the 3 AI mindmap endpoints:
 *   1. POST /ai/analyze-knowledge-graph   (analyze-graph.ts)
 *   2. POST /ai/suggest-student-connections (suggest-connections.ts)
 *   3. GET  /ai/student-weak-points        (student-weak-points.ts)
 *
 * Strategy: Unit tests with fully mocked Supabase + Claude dependencies.
 * We stub `authenticate`, DB calls, and `generateText` so tests run
 * without network, env vars, or real databases.
 *
 * Run: deno test supabase/functions/server/routes/ai/__tests__/mindmap-ai-endpoints.test.ts --allow-all
 */

import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  stub,
  restore,
  type Stub,
} from "https://deno.land/std@0.224.0/testing/mock.ts";

// ---------------------------------------------------------------------------
// Shared test constants
// ---------------------------------------------------------------------------

const FAKE_USER_ID = "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb";
const FAKE_TOPIC_ID = "cccccccc-4444-5555-6666-dddddddddddd";
const FAKE_INSTITUTION_ID = "eeeeeeee-7777-8888-9999-ffffffffffff";
const FAKE_SUMMARY_ID = "11111111-aaaa-bbbb-cccc-222222222222";
const FAKE_KEYWORD_A = "33333333-dddd-eeee-ffff-444444444444";
const FAKE_KEYWORD_B = "55555555-aaaa-bbbb-cccc-666666666666";
const FAKE_SUBTOPIC_A = "77777777-dddd-eeee-ffff-888888888888";
const FAKE_SUBTOPIC_B = "99999999-aaaa-bbbb-cccc-aaaaaaaaaaaa";

// A valid-looking JWT (header.payload.signature) where payload decodes to our user
// Payload: {"sub":"aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb","email":"test@axon.com","exp":9999999999}
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

// ---------------------------------------------------------------------------
// Mock Supabase client builder
//
// Creates a chainable object that mimics SupabaseClient. Each test configures
// which table returns what data/error via the `tableResponses` map.
// ---------------------------------------------------------------------------

interface MockResponse {
  data: unknown;
  error: { message: string } | null;
}

interface TableConfig {
  selectResponse?: MockResponse;
  rpcResponse?: MockResponse;
}

function createMockDb(tableConfigs: Record<string, TableConfig> = {}) {
  // rpc responses keyed by rpc function name
  const rpcResponses: Record<string, MockResponse> = {};

  // select chain responses keyed by table name; we track the "current table"
  // so the chain methods (eq, in_, is, or) eventually resolve to the right data.
  let currentTable = "";

  const chainable = {
    select: (_cols?: string) => chainable,
    eq: (_col: string, _val: unknown) => chainable,
    in: (_col: string, _val: unknown[]) => chainable,
    is: (_col: string, _val: unknown) => chainable,
    or: (_filter: string) => chainable,
    // Terminal — returns the configured response for the current table
    then(
      resolve: (v: MockResponse) => void,
      reject?: (e: unknown) => void,
    ) {
      const cfg = tableConfigs[currentTable];
      const resp = cfg?.selectResponse ?? { data: [], error: null };
      try {
        resolve(resp);
      } catch (e) {
        if (reject) reject(e);
      }
    },
  };

  // Make chainable thenable so `await db.from("x").select(...)` works
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
    },
  };
}

// ---------------------------------------------------------------------------
// We cannot import the route files directly because they transitively import
// db.ts which reads env vars at module load and throws. Instead we set the
// required env vars before importing, and stub the modules we need.
// ---------------------------------------------------------------------------

// Set required env vars BEFORE any import that touches db.ts
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_ANON_KEY", "fake-anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "fake-service-role-key");
Deno.env.set("ANTHROPIC_API_KEY", "fake-anthropic-key");

// Now we can import the route modules
import { Hono } from "npm:hono";
import * as dbMod from "../../../db.ts";
import * as authHelpers from "../../../auth-helpers.ts";
import * as claudeAi from "../../../claude-ai.ts";
import { aiAnalyzeGraphRoutes } from "../analyze-graph.ts";
import { aiSuggestConnectionsRoutes } from "../suggest-connections.ts";
import { aiWeakPointsRoutes } from "../student-weak-points.ts";

// ---------------------------------------------------------------------------
// Test app setup helper
// ---------------------------------------------------------------------------

function buildApp() {
  const app = new Hono();
  app.route("/", aiAnalyzeGraphRoutes);
  app.route("/", aiSuggestConnectionsRoutes);
  app.route("/", aiWeakPointsRoutes);
  return app;
}

// ---------------------------------------------------------------------------
// Stub helpers — set up and tear down mocks for each test
// ---------------------------------------------------------------------------

type StubList = Stub[];

function setupAuthStub(
  stubs: StubList,
  mockDb: ReturnType<typeof createMockDb>,
  opts?: { failAuth?: boolean; expiredJwt?: boolean },
) {
  // Stub authenticate to return our mock user + db
  const authStub = stub(
    dbMod,
    "authenticate",
    async (c) => {
      if (opts?.failAuth) {
        return dbMod.err(c, "Missing Authorization header", 401);
      }
      return {
        user: { id: FAKE_USER_ID, email: "test@axon.com" },
        db: mockDb.db as unknown as Parameters<typeof dbMod.authenticate>[0] extends infer _C ? ReturnType<typeof dbMod.getUserClient> : never,
      };
    },
  );
  stubs.push(authStub);

  // Stub requireInstitutionRole to always approve
  const roleStub = stub(
    authHelpers,
    "requireInstitutionRole",
    () =>
      Promise.resolve({
        role: "student",
        membershipId: "fake-membership-id",
      }),
  );
  stubs.push(roleStub);

  return { authStub, roleStub };
}

function setupStandardDbMock() {
  const mock = createMockDb();
  // resolve_parent_institution
  mock.setRpc("resolve_parent_institution", {
    data: FAKE_INSTITUTION_ID,
    error: null,
  });
  // summaries
  mock.setTable("summaries", {
    data: [{ id: FAKE_SUMMARY_ID }],
    error: null,
  });
  // keywords
  mock.setTable("keywords", {
    data: [
      { id: FAKE_KEYWORD_A, name: "Anatomia Cardiaca", definition: "Estudio del corazon", summary_id: FAKE_SUMMARY_ID },
      { id: FAKE_KEYWORD_B, name: "Fisiologia Pulmonar", definition: "Funcion del pulmon", summary_id: FAKE_SUMMARY_ID },
    ],
    error: null,
  });
  // keyword_connections
  mock.setTable("keyword_connections", {
    data: [
      {
        keyword_a_id: FAKE_KEYWORD_A,
        keyword_b_id: FAKE_KEYWORD_B,
        connection_type: "causa-efecto",
        relationship: "La funcion cardiaca afecta la perfusion pulmonar",
      },
    ],
    error: null,
  });
  // subtopics
  mock.setTable("subtopics", {
    data: [
      { id: FAKE_SUBTOPIC_A, keyword_id: FAKE_KEYWORD_A },
      { id: FAKE_SUBTOPIC_B, keyword_id: FAKE_KEYWORD_B },
    ],
    error: null,
  });
  // bkt_states
  mock.setTable("bkt_states", {
    data: [
      {
        subtopic_id: FAKE_SUBTOPIC_A,
        p_know: 0.25,
        total_attempts: 5,
        correct_attempts: 1,
        last_attempt_at: "2026-03-15T10:00:00Z",
      },
      {
        subtopic_id: FAKE_SUBTOPIC_B,
        p_know: 0.85,
        total_attempts: 12,
        correct_attempts: 10,
        last_attempt_at: "2026-03-16T10:00:00Z",
      },
    ],
    error: null,
  });
  return mock;
}

// =====================================================================
// 1. POST /server/ai/analyze-knowledge-graph
// =====================================================================

Deno.test("analyze-graph: returns 401 when no auth token", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb, { failAuth: true });

  try {
    const app = buildApp();
    const res = await app.request("/server/ai/analyze-knowledge-graph", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic_id: FAKE_TOPIC_ID }),
    });
    assertEquals(res.status, 401);
    const json = await res.json();
    assertExists(json.error);
  } finally {
    restore();
  }
});

Deno.test("analyze-graph: returns 400 when topic_id is missing", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  try {
    const app = buildApp();
    const res = await app.request("/server/ai/analyze-knowledge-graph", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: JSON.stringify({}),
    });
    assertEquals(res.status, 400);
    const json = await res.json();
    assertEquals(json.error, "topic_id is required (valid UUID)");
  } finally {
    restore();
  }
});

Deno.test("analyze-graph: returns 400 when topic_id is not a UUID", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  try {
    const app = buildApp();
    const res = await app.request("/server/ai/analyze-knowledge-graph", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: JSON.stringify({ topic_id: "not-a-uuid" }),
    });
    assertEquals(res.status, 400);
    const json = await res.json();
    assertEquals(json.error, "topic_id is required (valid UUID)");
  } finally {
    restore();
  }
});

Deno.test("analyze-graph: returns 400 for invalid JSON body", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  try {
    const app = buildApp();
    const res = await app.request("/server/ai/analyze-knowledge-graph", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: "this is not json {{{",
    });
    assertEquals(res.status, 400);
    const json = await res.json();
    assertEquals(json.error, "Invalid JSON body");
  } finally {
    restore();
  }
});

Deno.test("analyze-graph: returns 404 when topic has no institution", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  mockDb.setRpc("resolve_parent_institution", { data: null, error: null });
  setupAuthStub(stubs, mockDb);

  try {
    const app = buildApp();
    const res = await app.request("/server/ai/analyze-knowledge-graph", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: JSON.stringify({ topic_id: FAKE_TOPIC_ID }),
    });
    assertEquals(res.status, 404);
    const json = await res.json();
    assertExists(json.error);
  } finally {
    restore();
  }
});

Deno.test("analyze-graph: returns 404 when no active summaries", async () => {
  const stubs: StubList = [];
  const mockDb = setupStandardDbMock();
  // Override summaries to return empty
  mockDb.setTable("summaries", { data: [], error: null });
  setupAuthStub(stubs, mockDb);

  try {
    const app = buildApp();
    const res = await app.request("/server/ai/analyze-knowledge-graph", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: JSON.stringify({ topic_id: FAKE_TOPIC_ID }),
    });
    assertEquals(res.status, 404);
    const json = await res.json();
    assertExists(json.error);
  } finally {
    restore();
  }
});

Deno.test("analyze-graph: returns 404 when no keywords found", async () => {
  const stubs: StubList = [];
  const mockDb = setupStandardDbMock();
  mockDb.setTable("keywords", { data: [], error: null });
  setupAuthStub(stubs, mockDb);

  try {
    const app = buildApp();
    const res = await app.request("/server/ai/analyze-knowledge-graph", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: JSON.stringify({ topic_id: FAKE_TOPIC_ID }),
    });
    assertEquals(res.status, 404);
    const json = await res.json();
    assertExists(json.error);
  } finally {
    restore();
  }
});

Deno.test("analyze-graph: returns 502 when Claude call fails", async () => {
  const stubs: StubList = [];
  const mockDb = setupStandardDbMock();
  setupAuthStub(stubs, mockDb);

  const genStub = stub(
    claudeAi,
    "generateText",
    () => Promise.reject(new Error("Claude API down")),
  );
  stubs.push(genStub);

  try {
    const app = buildApp();
    const res = await app.request("/server/ai/analyze-knowledge-graph", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: JSON.stringify({ topic_id: FAKE_TOPIC_ID }),
    });
    assertEquals(res.status, 502);
    const json = await res.json();
    assertEquals(json.error, "AI analysis failed. Please try again later.");
  } finally {
    restore();
  }
});

Deno.test("analyze-graph: returns 502 when Claude returns invalid JSON", async () => {
  const stubs: StubList = [];
  const mockDb = setupStandardDbMock();
  setupAuthStub(stubs, mockDb);

  const genStub = stub(
    claudeAi,
    "generateText",
    () =>
      Promise.resolve({
        text: "This is not JSON at all!!!",
        tokensUsed: 100,
      }),
  );
  stubs.push(genStub);

  try {
    const app = buildApp();
    const res = await app.request("/server/ai/analyze-knowledge-graph", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: JSON.stringify({ topic_id: FAKE_TOPIC_ID }),
    });
    assertEquals(res.status, 502);
    const json = await res.json();
    assertEquals(json.error, "AI returned invalid response. Please try again.");
  } finally {
    restore();
  }
});

Deno.test("analyze-graph: returns 200 with correct shape on success", async () => {
  const stubs: StubList = [];
  const mockDb = setupStandardDbMock();
  setupAuthStub(stubs, mockDb);

  const claudeResponse = {
    weak_areas: [
      {
        keyword_id: FAKE_KEYWORD_A,
        keyword_name: "Anatomia Cardiaca",
        mastery: 0.25,
        recommendation: "Revisar los fundamentos de anatomia cardiaca",
      },
    ],
    strong_areas: [
      {
        keyword_id: FAKE_KEYWORD_B,
        keyword_name: "Fisiologia Pulmonar",
        mastery: 0.85,
      },
    ],
    missing_connections: [
      {
        from_keyword: "Anatomia Cardiaca",
        to_keyword: "Fisiologia Pulmonar",
        suggested_type: "mecanismo",
        reason: "El mecanismo de Frank-Starling conecta ambos conceptos",
      },
    ],
    study_path: [
      {
        step: 1,
        action: "review",
        keyword_id: FAKE_KEYWORD_A,
        reason: "Dominio bajo, necesita revision",
      },
    ],
    overall_score: 0.55,
    summary_text:
      "El estudiante tiene buen dominio de fisiologia pulmonar pero necesita reforzar anatomia cardiaca.",
  };

  const genStub = stub(
    claudeAi,
    "generateText",
    () =>
      Promise.resolve({
        text: JSON.stringify(claudeResponse),
        tokensUsed: 500,
      }),
  );
  stubs.push(genStub);

  try {
    const app = buildApp();
    const res = await app.request("/server/ai/analyze-knowledge-graph", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: JSON.stringify({ topic_id: FAKE_TOPIC_ID }),
    });
    assertEquals(res.status, 200);
    const json = await res.json();
    const data = json.data;

    // Verify response shape
    assertExists(data.weak_areas);
    assertExists(data.strong_areas);
    assertExists(data.missing_connections);
    assertExists(data.study_path);
    assertEquals(typeof data.overall_score, "number");
    assertEquals(typeof data.summary_text, "string");

    // Verify _meta is included
    assertExists(data._meta);
    assertEquals(typeof data._meta.model, "string");
    assertEquals(data._meta.tokens, 500);
    assertEquals(typeof data._meta.keyword_count, "number");
    assertEquals(typeof data._meta.connection_count, "number");
  } finally {
    restore();
  }
});

Deno.test("analyze-graph: returns 500 when summaries query fails", async () => {
  const stubs: StubList = [];
  const mockDb = setupStandardDbMock();
  mockDb.setTable("summaries", {
    data: null,
    error: { message: "connection refused" },
  });
  setupAuthStub(stubs, mockDb);

  try {
    const app = buildApp();
    const res = await app.request("/server/ai/analyze-knowledge-graph", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: JSON.stringify({ topic_id: FAKE_TOPIC_ID }),
    });
    assertEquals(res.status, 500);
    const json = await res.json();
    assertExists(json.error);
  } finally {
    restore();
  }
});

// =====================================================================
// 2. POST /server/ai/suggest-student-connections
// =====================================================================

Deno.test("suggest-connections: returns 401 when no auth", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb, { failAuth: true });

  try {
    const app = buildApp();
    const res = await app.request("/server/ai/suggest-student-connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic_id: FAKE_TOPIC_ID,
        existing_node_ids: [FAKE_KEYWORD_A],
        existing_edge_ids: [],
      }),
    });
    assertEquals(res.status, 401);
  } finally {
    restore();
  }
});

Deno.test("suggest-connections: returns 400 when topic_id missing", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  try {
    const app = buildApp();
    const res = await app.request("/server/ai/suggest-student-connections", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: JSON.stringify({
        existing_node_ids: [FAKE_KEYWORD_A],
        existing_edge_ids: [],
      }),
    });
    assertEquals(res.status, 400);
    const json = await res.json();
    assertEquals(json.error, "topic_id is required (valid UUID)");
  } finally {
    restore();
  }
});

Deno.test("suggest-connections: returns 400 when existing_node_ids is empty", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  try {
    const app = buildApp();
    const res = await app.request("/server/ai/suggest-student-connections", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: JSON.stringify({
        topic_id: FAKE_TOPIC_ID,
        existing_node_ids: [],
        existing_edge_ids: [],
      }),
    });
    assertEquals(res.status, 400);
    const json = await res.json();
    assertEquals(
      json.error,
      "existing_node_ids must be a non-empty array of UUIDs",
    );
  } finally {
    restore();
  }
});

Deno.test("suggest-connections: returns 400 when existing_node_ids is not array", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  try {
    const app = buildApp();
    const res = await app.request("/server/ai/suggest-student-connections", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: JSON.stringify({
        topic_id: FAKE_TOPIC_ID,
        existing_node_ids: "not-an-array",
        existing_edge_ids: [],
      }),
    });
    assertEquals(res.status, 400);
    const json = await res.json();
    assertEquals(
      json.error,
      "existing_node_ids must be a non-empty array of UUIDs",
    );
  } finally {
    restore();
  }
});

Deno.test("suggest-connections: returns 400 when node IDs exceed max (200)", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  // Generate 201 fake UUIDs
  const tooManyIds = Array.from(
    { length: 201 },
    (_, i) =>
      `${String(i).padStart(8, "0")}-aaaa-bbbb-cccc-dddddddddddd`,
  );

  try {
    const app = buildApp();
    const res = await app.request("/server/ai/suggest-student-connections", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: JSON.stringify({
        topic_id: FAKE_TOPIC_ID,
        existing_node_ids: tooManyIds,
        existing_edge_ids: [],
      }),
    });
    assertEquals(res.status, 400);
    const json = await res.json();
    assertEquals(json.error, "existing_node_ids cannot exceed 200 items");
  } finally {
    restore();
  }
});

Deno.test("suggest-connections: returns 400 when node ID is invalid UUID", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  try {
    const app = buildApp();
    const res = await app.request("/server/ai/suggest-student-connections", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: JSON.stringify({
        topic_id: FAKE_TOPIC_ID,
        existing_node_ids: ["not-a-uuid"],
        existing_edge_ids: [],
      }),
    });
    assertEquals(res.status, 400);
    const json = await res.json();
    assertExists(json.error);
    assertEquals(json.error.startsWith("Invalid UUID in existing_node_ids"), true);
  } finally {
    restore();
  }
});

Deno.test("suggest-connections: returns 400 when existing_edge_ids is missing", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  try {
    const app = buildApp();
    const res = await app.request("/server/ai/suggest-student-connections", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: JSON.stringify({
        topic_id: FAKE_TOPIC_ID,
        existing_node_ids: [FAKE_KEYWORD_A],
        // existing_edge_ids omitted
      }),
    });
    assertEquals(res.status, 400);
    const json = await res.json();
    assertEquals(json.error, "existing_edge_ids must be an array of strings");
  } finally {
    restore();
  }
});

Deno.test("suggest-connections: returns 502 when Claude returns non-array", async () => {
  const stubs: StubList = [];
  const mockDb = setupStandardDbMock();
  setupAuthStub(stubs, mockDb);

  const genStub = stub(
    claudeAi,
    "generateText",
    () =>
      Promise.resolve({
        text: JSON.stringify({ not: "an array" }),
        tokensUsed: 100,
      }),
  );
  stubs.push(genStub);

  try {
    const app = buildApp();
    const res = await app.request("/server/ai/suggest-student-connections", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: JSON.stringify({
        topic_id: FAKE_TOPIC_ID,
        existing_node_ids: [FAKE_KEYWORD_A, FAKE_KEYWORD_B],
        existing_edge_ids: [],
      }),
    });
    assertEquals(res.status, 502);
    const json = await res.json();
    assertEquals(json.error, "AI returned unexpected format");
  } finally {
    restore();
  }
});

Deno.test("suggest-connections: returns 502 when Claude returns invalid JSON", async () => {
  const stubs: StubList = [];
  const mockDb = setupStandardDbMock();
  setupAuthStub(stubs, mockDb);

  const genStub = stub(
    claudeAi,
    "generateText",
    () =>
      Promise.resolve({
        text: "NOT VALID JSON {{{",
        tokensUsed: 100,
      }),
  );
  stubs.push(genStub);

  try {
    const app = buildApp();
    const res = await app.request("/server/ai/suggest-student-connections", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: JSON.stringify({
        topic_id: FAKE_TOPIC_ID,
        existing_node_ids: [FAKE_KEYWORD_A, FAKE_KEYWORD_B],
        existing_edge_ids: [],
      }),
    });
    assertEquals(res.status, 502);
    const json = await res.json();
    assertEquals(json.error, "AI returned invalid JSON");
  } finally {
    restore();
  }
});

Deno.test("suggest-connections: returns 200 and filters invalid suggestions", async () => {
  const stubs: StubList = [];
  const mockDb = setupStandardDbMock();
  setupAuthStub(stubs, mockDb);

  const claudeResponse = [
    // Valid suggestion
    {
      source: FAKE_KEYWORD_A,
      target: FAKE_KEYWORD_B,
      type: "mecanismo",
      reason: "El corazon impulsa la sangre a los pulmones",
      confidence: 0.9,
    },
    // Invalid: unknown keyword ID
    {
      source: "00000000-0000-0000-0000-000000000000",
      target: FAKE_KEYWORD_B,
      type: "mecanismo",
      reason: "Should be filtered out",
      confidence: 0.8,
    },
    // Invalid: unknown connection type
    {
      source: FAKE_KEYWORD_A,
      target: FAKE_KEYWORD_B,
      type: "invalid-type",
      reason: "Should be filtered out",
      confidence: 0.7,
    },
    // Invalid: self-connection
    {
      source: FAKE_KEYWORD_A,
      target: FAKE_KEYWORD_A,
      type: "mecanismo",
      reason: "Should be filtered out",
      confidence: 0.6,
    },
    // Invalid: confidence out of range
    {
      source: FAKE_KEYWORD_A,
      target: FAKE_KEYWORD_B,
      type: "mecanismo",
      reason: "Should be filtered out",
      confidence: 1.5,
    },
  ];

  const genStub = stub(
    claudeAi,
    "generateText",
    () =>
      Promise.resolve({
        text: JSON.stringify(claudeResponse),
        tokensUsed: 300,
      }),
  );
  stubs.push(genStub);

  try {
    const app = buildApp();
    const res = await app.request("/server/ai/suggest-student-connections", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: JSON.stringify({
        topic_id: FAKE_TOPIC_ID,
        existing_node_ids: [FAKE_KEYWORD_A, FAKE_KEYWORD_B],
        existing_edge_ids: [],
      }),
    });
    assertEquals(res.status, 200);
    const json = await res.json();
    const data = json.data;

    // Only the first suggestion should survive filtering
    assertEquals(Array.isArray(data), true);
    assertEquals(data.length, 1);
    assertEquals(data[0].source, FAKE_KEYWORD_A);
    assertEquals(data[0].target, FAKE_KEYWORD_B);
    assertEquals(data[0].type, "mecanismo");
    assertEquals(data[0].confidence, 0.9);
  } finally {
    restore();
  }
});

Deno.test("suggest-connections: returns 404 when no summaries for topic", async () => {
  const stubs: StubList = [];
  const mockDb = setupStandardDbMock();
  mockDb.setTable("summaries", { data: [], error: null });
  setupAuthStub(stubs, mockDb);

  try {
    const app = buildApp();
    const res = await app.request("/server/ai/suggest-student-connections", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: JSON.stringify({
        topic_id: FAKE_TOPIC_ID,
        existing_node_ids: [FAKE_KEYWORD_A],
        existing_edge_ids: [],
      }),
    });
    assertEquals(res.status, 404);
    const json = await res.json();
    assertEquals(json.error, "No active summaries found for this topic");
  } finally {
    restore();
  }
});

Deno.test("suggest-connections: returns sorted by confidence descending", async () => {
  const stubs: StubList = [];
  const mockDb = setupStandardDbMock();
  setupAuthStub(stubs, mockDb);

  const claudeResponse = [
    {
      source: FAKE_KEYWORD_A,
      target: FAKE_KEYWORD_B,
      type: "mecanismo",
      reason: "Low confidence",
      confidence: 0.3,
    },
    {
      source: FAKE_KEYWORD_B,
      target: FAKE_KEYWORD_A,
      type: "causa-efecto",
      reason: "High confidence",
      confidence: 0.95,
    },
  ];

  const genStub = stub(
    claudeAi,
    "generateText",
    () =>
      Promise.resolve({
        text: JSON.stringify(claudeResponse),
        tokensUsed: 200,
      }),
  );
  stubs.push(genStub);

  try {
    const app = buildApp();
    const res = await app.request("/server/ai/suggest-student-connections", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": FAKE_JWT,
      },
      body: JSON.stringify({
        topic_id: FAKE_TOPIC_ID,
        existing_node_ids: [FAKE_KEYWORD_A, FAKE_KEYWORD_B],
        existing_edge_ids: [],
      }),
    });
    assertEquals(res.status, 200);
    const json = await res.json();
    const data = json.data;

    assertEquals(data.length, 2);
    // Highest confidence first
    assertEquals(data[0].confidence, 0.95);
    assertEquals(data[1].confidence, 0.3);
  } finally {
    restore();
  }
});

// =====================================================================
// 3. GET /server/ai/student-weak-points
// =====================================================================

Deno.test("weak-points: returns 401 when no auth", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb, { failAuth: true });

  try {
    const app = buildApp();
    const res = await app.request(
      `/server/ai/student-weak-points?topic_id=${FAKE_TOPIC_ID}`,
    );
    assertEquals(res.status, 401);
  } finally {
    restore();
  }
});

Deno.test("weak-points: returns 400 when topic_id query param missing", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  try {
    const app = buildApp();
    const res = await app.request("/server/ai/student-weak-points", {
      headers: { "X-Access-Token": FAKE_JWT },
    });
    assertEquals(res.status, 400);
    const json = await res.json();
    assertEquals(
      json.error,
      "topic_id query param is required (valid UUID)",
    );
  } finally {
    restore();
  }
});

Deno.test("weak-points: returns 400 when topic_id is invalid UUID", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);

  try {
    const app = buildApp();
    const res = await app.request(
      "/server/ai/student-weak-points?topic_id=not-a-uuid",
      { headers: { "X-Access-Token": FAKE_JWT } },
    );
    assertEquals(res.status, 400);
    const json = await res.json();
    assertEquals(
      json.error,
      "topic_id query param is required (valid UUID)",
    );
  } finally {
    restore();
  }
});

Deno.test("weak-points: returns 404 when institution not found", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  mockDb.setRpc("resolve_parent_institution", { data: null, error: null });
  setupAuthStub(stubs, mockDb);

  try {
    const app = buildApp();
    const res = await app.request(
      `/server/ai/student-weak-points?topic_id=${FAKE_TOPIC_ID}`,
      { headers: { "X-Access-Token": FAKE_JWT } },
    );
    assertEquals(res.status, 404);
    const json = await res.json();
    assertEquals(
      json.error,
      "Could not resolve institution for this topic",
    );
  } finally {
    restore();
  }
});

Deno.test("weak-points: returns empty data when no summaries", async () => {
  const stubs: StubList = [];
  const mockDb = setupStandardDbMock();
  mockDb.setTable("summaries", { data: [], error: null });
  setupAuthStub(stubs, mockDb);

  try {
    const app = buildApp();
    const res = await app.request(
      `/server/ai/student-weak-points?topic_id=${FAKE_TOPIC_ID}`,
      { headers: { "X-Access-Token": FAKE_JWT } },
    );
    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.data.data, []);
  } finally {
    restore();
  }
});

Deno.test("weak-points: returns empty data when no keywords", async () => {
  const stubs: StubList = [];
  const mockDb = setupStandardDbMock();
  mockDb.setTable("keywords", { data: [], error: null });
  setupAuthStub(stubs, mockDb);

  try {
    const app = buildApp();
    const res = await app.request(
      `/server/ai/student-weak-points?topic_id=${FAKE_TOPIC_ID}`,
      { headers: { "X-Access-Token": FAKE_JWT } },
    );
    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.data.data, []);
  } finally {
    restore();
  }
});

Deno.test("weak-points: returns empty data when no subtopics", async () => {
  const stubs: StubList = [];
  const mockDb = setupStandardDbMock();
  mockDb.setTable("subtopics", { data: [], error: null });
  setupAuthStub(stubs, mockDb);

  try {
    const app = buildApp();
    const res = await app.request(
      `/server/ai/student-weak-points?topic_id=${FAKE_TOPIC_ID}`,
      { headers: { "X-Access-Token": FAKE_JWT } },
    );
    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.data.data, []);
  } finally {
    restore();
  }
});

Deno.test("weak-points: returns 500 when DB query fails", async () => {
  const stubs: StubList = [];
  const mockDb = setupStandardDbMock();
  mockDb.setTable("summaries", {
    data: null,
    error: { message: "connection timeout" },
  });
  setupAuthStub(stubs, mockDb);

  try {
    const app = buildApp();
    const res = await app.request(
      `/server/ai/student-weak-points?topic_id=${FAKE_TOPIC_ID}`,
      { headers: { "X-Access-Token": FAKE_JWT } },
    );
    assertEquals(res.status, 500);
    const json = await res.json();
    assertExists(json.error);
  } finally {
    restore();
  }
});

Deno.test("weak-points: returns weak keywords sorted by mastery ascending", async () => {
  const stubs: StubList = [];
  const mockDb = setupStandardDbMock();
  // Override BKT to have two weak keywords with different mastery
  mockDb.setTable("bkt_states", {
    data: [
      {
        subtopic_id: FAKE_SUBTOPIC_A,
        p_know: 0.15,
        total_attempts: 3,
        last_attempt_at: "2026-03-14T10:00:00Z",
      },
      {
        subtopic_id: FAKE_SUBTOPIC_B,
        p_know: 0.45,
        total_attempts: 8,
        last_attempt_at: "2026-03-16T10:00:00Z",
      },
    ],
    error: null,
  });
  setupAuthStub(stubs, mockDb);

  try {
    const app = buildApp();
    const res = await app.request(
      `/server/ai/student-weak-points?topic_id=${FAKE_TOPIC_ID}`,
      { headers: { "X-Access-Token": FAKE_JWT } },
    );
    assertEquals(res.status, 200);
    const json = await res.json();
    const weakPoints = json.data.data;

    assertEquals(Array.isArray(weakPoints), true);
    // Both are below 0.7 so both should appear
    assertEquals(weakPoints.length, 2);
    // Sorted ascending by mastery (weakest first)
    assertEquals(weakPoints[0].mastery <= weakPoints[1].mastery, true);
  } finally {
    restore();
  }
});

Deno.test("weak-points: filters out strong keywords (mastery >= 0.7)", async () => {
  const stubs: StubList = [];
  const mockDb = setupStandardDbMock();
  // One weak (0.25), one strong (0.85) - only weak should appear
  mockDb.setTable("bkt_states", {
    data: [
      {
        subtopic_id: FAKE_SUBTOPIC_A,
        p_know: 0.25,
        total_attempts: 5,
        last_attempt_at: "2026-03-14T10:00:00Z",
      },
      {
        subtopic_id: FAKE_SUBTOPIC_B,
        p_know: 0.85,
        total_attempts: 12,
        last_attempt_at: "2026-03-16T10:00:00Z",
      },
    ],
    error: null,
  });
  setupAuthStub(stubs, mockDb);

  try {
    const app = buildApp();
    const res = await app.request(
      `/server/ai/student-weak-points?topic_id=${FAKE_TOPIC_ID}`,
      { headers: { "X-Access-Token": FAKE_JWT } },
    );
    assertEquals(res.status, 200);
    const json = await res.json();
    const weakPoints = json.data.data;

    assertEquals(weakPoints.length, 1);
    assertEquals(weakPoints[0].keyword_id, FAKE_KEYWORD_A);
    assertEquals(weakPoints[0].mastery, 0.25);
  } finally {
    restore();
  }
});

Deno.test("weak-points: assigns correct recommended_action based on mastery", async () => {
  const stubs: StubList = [];
  const mockDb = setupStandardDbMock();
  // mastery < 0.3 -> "review", 0.3-0.5 -> "flashcard", 0.5-0.7 -> "quiz"
  mockDb.setTable("bkt_states", {
    data: [
      {
        subtopic_id: FAKE_SUBTOPIC_A,
        p_know: 0.1, // < 0.3 -> review
        total_attempts: 2,
        last_attempt_at: "2026-03-14T10:00:00Z",
      },
      {
        subtopic_id: FAKE_SUBTOPIC_B,
        p_know: 0.55, // 0.5-0.7 -> quiz
        total_attempts: 8,
        last_attempt_at: "2026-03-16T10:00:00Z",
      },
    ],
    error: null,
  });
  setupAuthStub(stubs, mockDb);

  try {
    const app = buildApp();
    const res = await app.request(
      `/server/ai/student-weak-points?topic_id=${FAKE_TOPIC_ID}`,
      { headers: { "X-Access-Token": FAKE_JWT } },
    );
    assertEquals(res.status, 200);
    const json = await res.json();
    const weakPoints = json.data.data;

    assertEquals(weakPoints.length, 2);
    // Sorted by mastery ascending, so 0.1 first
    const reviewItem = weakPoints.find(
      (wp: { recommended_action: string }) => wp.recommended_action === "review",
    );
    const quizItem = weakPoints.find(
      (wp: { recommended_action: string }) => wp.recommended_action === "quiz",
    );
    assertExists(reviewItem);
    assertExists(quizItem);
    assertEquals(reviewItem.mastery, 0.1);
    assertEquals(quizItem.mastery, 0.55);
  } finally {
    restore();
  }
});

Deno.test("weak-points: response shape matches WeakPoint interface", async () => {
  const stubs: StubList = [];
  const mockDb = setupStandardDbMock();
  mockDb.setTable("bkt_states", {
    data: [
      {
        subtopic_id: FAKE_SUBTOPIC_A,
        p_know: 0.35,
        total_attempts: 5,
        last_attempt_at: "2026-03-14T10:00:00Z",
      },
    ],
    error: null,
  });
  setupAuthStub(stubs, mockDb);

  try {
    const app = buildApp();
    const res = await app.request(
      `/server/ai/student-weak-points?topic_id=${FAKE_TOPIC_ID}`,
      { headers: { "X-Access-Token": FAKE_JWT } },
    );
    assertEquals(res.status, 200);
    const json = await res.json();
    const weakPoints = json.data.data;

    for (const wp of weakPoints) {
      // Verify all WeakPoint fields exist and have correct types
      assertEquals(typeof wp.keyword_id, "string");
      assertEquals(typeof wp.name, "string");
      assertEquals(typeof wp.mastery, "number");
      // last_reviewed can be string or null
      assertEquals(
        wp.last_reviewed === null || typeof wp.last_reviewed === "string",
        true,
      );
      assertEquals(
        ["review", "flashcard", "quiz"].includes(wp.recommended_action),
        true,
      );
      // Mastery should have max 3 decimal places
      const decimals = wp.mastery.toString().split(".")[1]?.length ?? 0;
      assertEquals(decimals <= 3, true);
    }
  } finally {
    restore();
  }
});

Deno.test("weak-points: limits results to 20 items", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();

  // Set up RPC
  mockDb.setRpc("resolve_parent_institution", {
    data: FAKE_INSTITUTION_ID,
    error: null,
  });
  mockDb.setTable("summaries", {
    data: [{ id: FAKE_SUMMARY_ID }],
    error: null,
  });

  // Generate 25 keywords, subtopics, and BKT states (all weak)
  const manyKeywords = Array.from({ length: 25 }, (_, i) => ({
    id: `${String(i).padStart(8, "0")}-aaaa-bbbb-cccc-dddddddddddd`,
    name: `Keyword ${i}`,
    summary_id: FAKE_SUMMARY_ID,
  }));
  mockDb.setTable("keywords", { data: manyKeywords, error: null });

  const manySubtopics = manyKeywords.map((kw, i) => ({
    id: `${String(i).padStart(8, "0")}-1111-2222-3333-eeeeeeeeeeee`,
    keyword_id: kw.id,
  }));
  mockDb.setTable("subtopics", { data: manySubtopics, error: null });

  const manyBktStates = manySubtopics.map((st, i) => ({
    subtopic_id: st.id,
    p_know: 0.01 * (i + 1), // all < 0.7
    total_attempts: i + 1,
    last_attempt_at: `2026-03-${String(i + 1).padStart(2, "0")}T10:00:00Z`,
  }));
  mockDb.setTable("bkt_states", { data: manyBktStates, error: null });

  setupAuthStub(stubs, mockDb);

  try {
    const app = buildApp();
    const res = await app.request(
      `/server/ai/student-weak-points?topic_id=${FAKE_TOPIC_ID}`,
      { headers: { "X-Access-Token": FAKE_JWT } },
    );
    assertEquals(res.status, 200);
    const json = await res.json();
    const weakPoints = json.data.data;

    // Should be capped at 20
    assertEquals(weakPoints.length <= 20, true);
  } finally {
    restore();
  }
});

Deno.test("weak-points: handles no BKT data gracefully (all subtopics p_know=0)", async () => {
  const stubs: StubList = [];
  const mockDb = setupStandardDbMock();
  // No BKT states at all -- student hasn't attempted anything
  mockDb.setTable("bkt_states", { data: [], error: null });
  setupAuthStub(stubs, mockDb);

  try {
    const app = buildApp();
    const res = await app.request(
      `/server/ai/student-weak-points?topic_id=${FAKE_TOPIC_ID}`,
      { headers: { "X-Access-Token": FAKE_JWT } },
    );
    assertEquals(res.status, 200);
    const json = await res.json();
    const weakPoints = json.data.data;

    // All keywords should appear as weak (mastery = 0, which is < 0.7)
    assertEquals(weakPoints.length, 2);
    // All should have mastery 0 and recommended_action "review"
    for (const wp of weakPoints) {
      assertEquals(wp.mastery, 0);
      assertEquals(wp.recommended_action, "review");
      assertEquals(wp.last_reviewed, null);
    }
  } finally {
    restore();
  }
});

/**
 * tests/integration/fase4-query-log-feedback.test.ts
 *
 * Integration tests for Fase 4 (T-03): Query Logging + Feedback Loop
 *
 * Tests (sequential — each depends on previous state):
 *   1.  POST /ai/rag-chat         → log created, log_id returned
 *   2.  PATCH /ai/rag-feedback     → thumbs up (feedback=1)
 *   3.  PATCH /ai/rag-feedback     → thumbs down (feedback=-1)
 *   4.  PATCH /ai/rag-feedback     → RLS blocks other user
 *   5a. PATCH /ai/rag-feedback     → rejects feedback=0
 *   5b. PATCH /ai/rag-feedback     → rejects invalid UUID
 *   6.  GET /ai/rag-analytics      → returns metrics (admin)
 *   7.  GET /ai/rag-analytics      → date range filter works
 *   8.  GET /ai/rag-analytics      → non-admin blocked
 *   9.  GET /ai/embedding-coverage → returns coverage data (admin)
 *   10. GET /ai/embedding-coverage → non-admin blocked
 *
 * Run locally:
 *   deno test tests/integration/fase4-query-log-feedback.test.ts \
 *     --allow-net --allow-env --no-check
 *
 * Required env vars: see tests/helpers/test-client.ts
 */

import {
  ENV,
  login,
  api,
  assertOk,
  assertError,
  isUuid,
} from "../helpers/test-client.ts";
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";

// ─── Shared state across sequential steps ───────────────────────────
let userToken = "";
let adminToken = "";
let logId = "";
let institutionId = "";

// ─── Setup ──────────────────────────────────────────────────────────

Deno.test("Fase 4 — Setup: login test users", async () => {
  const [userSession, adminSession] = await Promise.all([
    login(ENV.USER_EMAIL, ENV.USER_PASSWORD),
    login(ENV.ADMIN_EMAIL, ENV.ADMIN_PASSWORD),
  ]);

  userToken = userSession.access_token;
  adminToken = adminSession.access_token;
  institutionId = ENV.INSTITUTION_ID;

  assert(userToken.length > 0, "User login failed — no token");
  assert(adminToken.length > 0, "Admin login failed — no token");
  assert(isUuid(institutionId), "TEST_INSTITUTION_ID must be a valid UUID");

  console.log(`  ✓ User logged in:  ${userSession.user.email} (${userSession.user.id})`);
  console.log(`  ✓ Admin logged in: ${adminSession.user.email} (${adminSession.user.id})`);
  console.log(`  ✓ Institution:     ${institutionId}`);
});

// ─── Test 1: POST /ai/rag-chat → log_id returned ───────────────────

Deno.test("Test 1: POST /ai/rag-chat → creates log, returns log_id", async () => {
  interface ChatResponse {
    response: string;
    sources: Array<{ chunk_id: string; summary_title: string; similarity: number }>;
    log_id: string;
    _search: { augmented: boolean; context_chunks: number; primary_matches: number };
  }

  const res = await api.post<ChatResponse>(
    "/ai/rag-chat",
    userToken,
    { message: "¿Qué es la mitosis? (integration test)" },
  );

  const data = assertOk(res, "rag-chat should return 200");

  // Validate log_id
  assert(isUuid(data.log_id), `log_id should be a valid UUID, got: ${data.log_id}`);
  logId = data.log_id;

  // Validate response structure
  assert(typeof data.response === "string" && data.response.length > 0,
    "response should be a non-empty string");
  assert(Array.isArray(data.sources), "sources should be an array");
  assert(typeof data._search === "object", "_search metadata should exist");
  assert(typeof data._search.augmented === "boolean", "_search.augmented should be boolean");

  console.log(`  ✓ log_id: ${logId}`);
  console.log(`  ✓ sources: ${data.sources.length} matches`);
  console.log(`  ✓ response length: ${data.response.length} chars`);
});

// ─── Test 2: PATCH /ai/rag-feedback → thumbs up ────────────────────

Deno.test("Test 2: PATCH /ai/rag-feedback → feedback=1 (thumbs up)", async () => {
  assert(logId, "Test 1 must run first (logId required)");

  interface FeedbackResponse {
    updated: { id: string; feedback: number; created_at: string };
  }

  const res = await api.patch<FeedbackResponse>(
    "/ai/rag-feedback",
    userToken,
    { log_id: logId, feedback: 1 },
  );

  const data = assertOk(res, "feedback update should return 200");
  assertEquals(data.updated.feedback, 1, "feedback should be 1");
  assertEquals(data.updated.id, logId, "returned id should match log_id");

  console.log(`  ✓ feedback set to 1 (thumbs up)`);
});

// ─── Test 3: PATCH /ai/rag-feedback → thumbs down ──────────────────

Deno.test("Test 3: PATCH /ai/rag-feedback → feedback=-1 (thumbs down)", async () => {
  assert(logId, "Test 1 must run first (logId required)");

  interface FeedbackResponse {
    updated: { id: string; feedback: number; created_at: string };
  }

  const res = await api.patch<FeedbackResponse>(
    "/ai/rag-feedback",
    userToken,
    { log_id: logId, feedback: -1 },
  );

  const data = assertOk(res, "feedback update should return 200");
  assertEquals(data.updated.feedback, -1, "feedback should be -1");

  console.log(`  ✓ feedback changed to -1 (thumbs down)`);
});

// ─── Test 4: PATCH /ai/rag-feedback → RLS blocks other user ────────

Deno.test("Test 4: PATCH /ai/rag-feedback → other user blocked by RLS", async () => {
  assert(logId, "Test 1 must run first (logId required)");

  // Admin tries to update user's log → RLS should block
  const res = await api.patch(
    "/ai/rag-feedback",
    adminToken,
    { log_id: logId, feedback: 1 },
  );

  assertError(res, 404, "RLS should block update by non-owner");

  console.log(`  ✓ Admin correctly blocked from updating user's log (404)`);
});

// ─── Test 5a: PATCH /ai/rag-feedback → rejects feedback=0 ─────────

Deno.test("Test 5a: PATCH /ai/rag-feedback → rejects invalid feedback value", async () => {
  assert(logId, "Test 1 must run first (logId required)");

  const res = await api.patch(
    "/ai/rag-feedback",
    userToken,
    { log_id: logId, feedback: 0 },
  );

  assertError(res, 400, "feedback=0 should be rejected");
  assert(
    res.error?.includes("feedback must be 1") || res.error?.includes("thumbs"),
    `Error message should mention valid values, got: ${res.error}`,
  );

  console.log(`  ✓ feedback=0 correctly rejected (400)`);
});

// ─── Test 5b: PATCH /ai/rag-feedback → rejects invalid UUID ───────

Deno.test("Test 5b: PATCH /ai/rag-feedback → rejects invalid log_id", async () => {
  const res = await api.patch(
    "/ai/rag-feedback",
    userToken,
    { log_id: "not-a-uuid", feedback: 1 },
  );

  assertError(res, 400, "invalid UUID should be rejected");
  assert(
    res.error?.includes("log_id") || res.error?.includes("UUID"),
    `Error message should mention log_id, got: ${res.error}`,
  );

  console.log(`  ✓ invalid UUID correctly rejected (400)`);
});

// ─── Test 6: GET /ai/rag-analytics → metrics as admin ──────────────

Deno.test("Test 6: GET /ai/rag-analytics → returns aggregated metrics (admin)", async () => {
  interface AnalyticsResponse {
    total_queries: number;
    avg_similarity: number | null;
    avg_latency_ms: number | null;
    positive_feedback: number;
    negative_feedback: number;
    zero_result_queries: number;
  }

  const res = await api.get<AnalyticsResponse>(
    `/ai/rag-analytics?institution_id=${institutionId}`,
    adminToken,
  );

  const data = assertOk(res, "analytics should return 200 for admin");

  // Validate structure
  assert(typeof data.total_queries === "number", "total_queries should be a number");
  assert(typeof data.positive_feedback === "number", "positive_feedback should be a number");
  assert(typeof data.negative_feedback === "number", "negative_feedback should be a number");
  assert(typeof data.zero_result_queries === "number", "zero_result_queries should be a number");

  // After our tests, there should be at least 1 query
  assert(data.total_queries >= 1, `Expected at least 1 query, got ${data.total_queries}`);

  console.log(`  ✓ total_queries: ${data.total_queries}`);
  console.log(`  ✓ avg_similarity: ${data.avg_similarity}`);
  console.log(`  ✓ avg_latency_ms: ${data.avg_latency_ms}`);
  console.log(`  ✓ positive: ${data.positive_feedback}, negative: ${data.negative_feedback}`);
  console.log(`  ✓ zero_result_queries: ${data.zero_result_queries}`);
});

// ─── Test 7: GET /ai/rag-analytics → date range filter ─────────────

Deno.test("Test 7: GET /ai/rag-analytics → date range filter works", async () => {
  // Future date range → should return 0 queries
  const futureFrom = "2027-01-01T00:00:00Z";
  const res = await api.get<{ total_queries: number }>(
    `/ai/rag-analytics?institution_id=${institutionId}&from=${futureFrom}`,
    adminToken,
  );

  const data = assertOk(res, "analytics with date range should return 200");
  assertEquals(data.total_queries, 0, "Future date range should return 0 queries");

  console.log(`  ✓ Future range correctly returns 0 queries`);

  // Current range → should include our test query
  const pastFrom = new Date(Date.now() - 3600_000).toISOString();
  const res2 = await api.get<{ total_queries: number }>(
    `/ai/rag-analytics?institution_id=${institutionId}&from=${pastFrom}`,
    adminToken,
  );

  const data2 = assertOk(res2, "analytics with current range should return 200");
  assert(data2.total_queries >= 1, `Current range should include test query, got ${data2.total_queries}`);

  console.log(`  ✓ Current range includes test query (${data2.total_queries} total)`);
});

// ─── Test 8: GET /ai/rag-analytics → non-admin blocked ────────────

Deno.test("Test 8: GET /ai/rag-analytics → non-admin blocked", async () => {
  const res = await api.get(
    `/ai/rag-analytics?institution_id=${institutionId}`,
    userToken,
  );

  // requireInstitutionRole blocks non-admin → 403
  assertError(res, 403, "Non-admin should be blocked from analytics");

  console.log(`  ✓ Regular user correctly blocked from analytics (${res.status})`);
});

// ─── Test 9: GET /ai/embedding-coverage → returns data ────────────

Deno.test("Test 9: GET /ai/embedding-coverage → returns coverage data (admin)", async () => {
  interface CoverageResponse {
    total_chunks: number;
    chunks_with_embedding: number;
    coverage_pct: number;
  }

  const res = await api.get<CoverageResponse>(
    `/ai/embedding-coverage?institution_id=${institutionId}`,
    adminToken,
  );

  const data = assertOk(res, "embedding-coverage should return 200 for admin");

  // Validate structure
  assert(typeof data.total_chunks === "number", "total_chunks should be a number");
  assert(typeof data.chunks_with_embedding === "number", "chunks_with_embedding should be a number");
  assert(typeof data.coverage_pct === "number", "coverage_pct should be a number");

  // coverage_pct should be between 0 and 100
  assert(data.coverage_pct >= 0 && data.coverage_pct <= 100,
    `coverage_pct should be 0-100, got ${data.coverage_pct}`);

  // chunks_with_embedding <= total_chunks
  assert(data.chunks_with_embedding <= data.total_chunks,
    "chunks_with_embedding should not exceed total_chunks");

  console.log(`  ✓ total_chunks: ${data.total_chunks}`);
  console.log(`  ✓ chunks_with_embedding: ${data.chunks_with_embedding}`);
  console.log(`  ✓ coverage_pct: ${data.coverage_pct}%`);
});

// ─── Test 10: GET /ai/embedding-coverage → non-admin blocked ───────

Deno.test("Test 10: GET /ai/embedding-coverage → non-admin blocked", async () => {
  const res = await api.get(
    `/ai/embedding-coverage?institution_id=${institutionId}`,
    userToken,
  );

  assertError(res, 403, "Non-admin should be blocked from embedding-coverage");

  console.log(`  ✓ Regular user correctly blocked from coverage (${res.status})`);
});

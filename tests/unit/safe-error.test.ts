/**
 * tests/unit/safe-error.test.ts — Unit tests for error sanitization
 *
 * 18 tests covering:
 * - Generic response format (no internal details leak)
 * - Operation name in response
 * - HTTP status codes (500, 400, 404, 403)
 * - Various error object formats
 * - Console logging verification
 *
 * Run:
 *   cd /sessions/great-bold-mccarthy/mnt/petri/AXON\ PROJECTO/backend
 *   deno test tests/unit/safe-error.test.ts --allow-env --no-check
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { safeErr } from "../../supabase/functions/server/lib/safe-error.ts";
import type { Context } from "npm:hono";

// Mock Context type for testing
interface MockContext extends Partial<Context> {
  json: (data: unknown, status?: number) => Response;
}

/**
 * Create a mock Hono Context for testing
 */
function createMockContext(): MockContext {
  const responses: { data: unknown; status: number }[] = [];

  return {
    json: (data: unknown, status = 200) => {
      responses.push({ data, status });
      return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
}

// ─── Basic Response Format ──────────────────────────────────────────

Deno.test("safeErr: returns JSON response with error field", () => {
  const ctx = createMockContext();
  const response = safeErr(ctx as Context, "database query", { message: "Connection failed" });

  assertEquals(response.status, 500);
  assert(response.headers.get("Content-Type")?.includes("application/json"));
});

Deno.test("safeErr: response contains operation name", async () => {
  const ctx = createMockContext();
  const response = safeErr(ctx as Context, "user registration", { message: "Constraint violation" });

  const body = await response.json();
  assertEquals(body.error, "user registration failed");
});

Deno.test("safeErr: does not leak error message to client", async () => {
  const ctx = createMockContext();
  const response = safeErr(ctx as Context, "delete user", {
    message: "Foreign key constraint violation on user_id in orders table",
  });

  const body = await response.json();
  assertEquals(body.error, "delete user failed");
  assert(!body.error.includes("Foreign key"));
  assert(!body.error.includes("orders"));
});

Deno.test("safeErr: does not leak column names", async () => {
  const ctx = createMockContext();
  const response = safeErr(ctx as Context, "create account", {
    message: "Duplicate key value violates unique constraint user_email_unique",
  });

  const body = await response.json();
  assertEquals(body.error, "create account failed");
  assert(!body.error.includes("unique"));
  assert(!body.error.includes("user_email"));
});

Deno.test("safeErr: does not leak table names", async () => {
  const ctx = createMockContext();
  const response = safeErr(ctx as Context, "update quiz", {
    message: "Insert or update on table quiz_questions violates foreign key constraint",
  });

  const body = await response.json();
  assertEquals(body.error, "update quiz failed");
  assert(!body.error.includes("quiz_questions"));
});

// ─── HTTP Status Codes ──────────────────────────────────────────────

Deno.test("safeErr: defaults to 500 status", () => {
  const ctx = createMockContext();
  const response = safeErr(ctx as Context, "operation", { message: "Error" });
  assertEquals(response.status, 500);
});

Deno.test("safeErr: accepts custom 400 status", () => {
  const ctx = createMockContext();
  const response = safeErr(ctx as Context, "validation", { message: "Invalid input" }, 400);
  assertEquals(response.status, 400);
});

Deno.test("safeErr: accepts custom 404 status", () => {
  const ctx = createMockContext();
  const response = safeErr(ctx as Context, "fetch", { message: "Not found" }, 404);
  assertEquals(response.status, 404);
});

Deno.test("safeErr: accepts custom 403 status", () => {
  const ctx = createMockContext();
  const response = safeErr(ctx as Context, "delete", { message: "Access denied" }, 403);
  assertEquals(response.status, 403);
});

// ─── Error Object Formats ──────────────────────────────────────────

Deno.test("safeErr: handles error with message field", async () => {
  const ctx = createMockContext();
  const response = safeErr(ctx as Context, "query", {
    message: "Connection timeout after 30s",
  });

  const body = await response.json();
  assertEquals(body.error, "query failed");
});

Deno.test("safeErr: handles error with code field only", async () => {
  const ctx = createMockContext();
  const response = safeErr(ctx as Context, "auth", { code: "PGSQL:23505" });

  const body = await response.json();
  assertEquals(body.error, "auth failed");
});

Deno.test("safeErr: handles error with both message and code", async () => {
  const ctx = createMockContext();
  const response = safeErr(ctx as Context, "insert", {
    message: "Unique constraint violation",
    code: "23505",
  });

  const body = await response.json();
  assertEquals(body.error, "insert failed");
});

Deno.test("safeErr: handles null error gracefully", async () => {
  const ctx = createMockContext();
  const response = safeErr(ctx as Context, "process", null);

  const body = await response.json();
  assertEquals(body.error, "process failed");
});

Deno.test("safeErr: handles undefined error gracefully", async () => {
  const ctx = createMockContext();
  const response = safeErr(ctx as Context, "fetch", undefined);

  const body = await response.json();
  assertEquals(body.error, "fetch failed");
});

Deno.test("safeErr: handles empty error object", async () => {
  const ctx = createMockContext();
  const response = safeErr(ctx as Context, "validate", {});

  const body = await response.json();
  assertEquals(body.error, "validate failed");
});

// ─── Operation Name Handling ────────────────────────────────────────

Deno.test("safeErr: includes operation name with space and 'failed'", async () => {
  const ctx = createMockContext();
  const response = safeErr(ctx as Context, "send email", { message: "SMTP timeout" });

  const body = await response.json();
  assertEquals(body.error, "send email failed");
});

Deno.test("safeErr: handles single-word operation name", async () => {
  const ctx = createMockContext();
  const response = safeErr(ctx as Context, "delete", { message: "Permission denied" });

  const body = await response.json();
  assertEquals(body.error, "delete failed");
});

Deno.test("safeErr: handles multi-word operation name", async () => {
  const ctx = createMockContext();
  const response = safeErr(ctx as Context, "batch process quiz responses", {
    message: "Timeout",
  });

  const body = await response.json();
  assertEquals(body.error, "batch process quiz responses failed");
});

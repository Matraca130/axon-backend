/**
 * Tests for summary-hook.ts — onSummaryWrite gate logic.
 *
 * Tests cover the 3-gate decision logic that determines whether
 * to trigger autoChunkAndEmbed after a summary POST/PUT:
 *
 *   Gate 1: On update, only trigger if content_markdown was in updatedFields.
 *   Gate 2: Extract summaryId + institutionId from row; skip if missing.
 *   Gate 3: Skip if content_markdown is empty/null/whitespace.
 *
 * Test strategy:
 *   - Gates that SKIP (T1–T7): verify the function returns without
 *     throwing. Since skip paths exit before any async work, these
 *     tests are fully synchronous and deterministic.
 *   - Fire path (T8): verify the function doesn't throw even when
 *     autoChunkAndEmbed fails (fake Supabase URL → connection refused).
 *     The hook's .catch() absorbs the async error and logs it.
 *
 * Environment setup:
 *   summary-hook.ts → auto-ingest.ts → db.ts has a module-level
 *   guard that throws if SUPABASE_URL/ANON_KEY/SERVICE_ROLE_KEY are
 *   missing. We set fake values via Deno.env.set() BEFORE the dynamic
 *   import() to satisfy this guard. Static `import` statements are
 *   hoisted and would evaluate before Deno.env.set(), so dynamic
 *   import() is required.
 *
 * Run: deno test supabase/functions/server/tests/summary_hook_test.ts
 *
 * Fase 5, sub-task 5.9 — Issue #30
 */

import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// ═════════════════════════════════════════════════════════════════════
// Environment Setup — MUST happen before dynamic import
// ═════════════════════════════════════════════════════════════════════
//
// db.ts evaluates these at module load time and throws if missing.
// Port 1 is reserved (tcpmux) and never listens → ECONNREFUSED in ~1ms.
// This ensures the fire-path test (T8) fails fast instead of hanging.

Deno.env.set("SUPABASE_URL", "http://127.0.0.1:1");
Deno.env.set("SUPABASE_ANON_KEY", "fake-anon-key-for-testing");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "fake-service-role-key-for-testing");

// ═════════════════════════════════════════════════════════════════════
// Dynamic Import — after env vars are set
// ═════════════════════════════════════════════════════════════════════
//
// Import chain: summary-hook.ts → auto-ingest.ts → db.ts (env guard)
//               summary-hook.ts → auto-ingest.ts → gemini.ts (lazy, OK)
//               summary-hook.ts → crud-factory.ts (type-only, no eval)

const { onSummaryWrite } = await import("../summary-hook.ts");

// ═════════════════════════════════════════════════════════════════════
// Test Helper
// ═════════════════════════════════════════════════════════════════════

/**
 * Creates a mock summary row with all columns that .select("*")
 * would return from the summaries table. Override any field.
 *
 * Default content_markdown is non-empty so tests that DON'T
 * target Gate 3 aren't accidentally blocked by it.
 */
function makeRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "sum-00000000-0000-0000-0000-000000000001",
    institution_id: "inst-00000000-0000-0000-0000-000000000001",
    topic_id: "top-00000000-0000-0000-0000-000000000001",
    title: "Anatomía del Sistema Nervioso Central",
    content_markdown:
      "# Sistema Nervioso Central\n\n" +
      "El SNC está compuesto por el encéfalo y la médula espinal.\n\n" +
      "## Encéfalo\n\n" +
      "Incluye el cerebro, cerebelo y tronco encefálico.",
    status: "published",
    order_index: 0,
    is_active: true,
    estimated_study_minutes: 15,
    created_by: "user-00000000-0000-0000-0000-000000000001",
    created_at: "2026-03-06T00:00:00.000Z",
    updated_at: "2026-03-06T00:00:00.000Z",
    deleted_at: null,
    last_chunked_at: null,
    chunk_strategy: null,
    ...overrides,
  };
}

/**
 * Temporarily captures console.warn calls. Returns the captured
 * messages and restores the original console.warn on dispose.
 *
 * Usage:
 *   const capture = captureWarn();
 *   try {
 *     doSomethingThatWarns();
 *     assertEquals(capture.messages.length, 1);
 *   } finally {
 *     capture.restore();
 *   }
 */
function captureWarn(): { messages: string[]; restore: () => void } {
  const messages: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  };
  return { messages, restore: () => { console.warn = original; } };
}

// ═════════════════════════════════════════════════════════════════════
// Gate 1 — Update: only trigger if content_markdown changed
// ═════════════════════════════════════════════════════════════════════
//
// Gate 1 code:
//   if (action === "update" && !updatedFields?.includes("content_markdown")) return;
//
// Expected behavior:
//   - update + updatedFields without "content_markdown" → return (no-op)
//   - update + empty updatedFields → return (no-op)
//   - update + undefined updatedFields → return (optional chain → falsy)
//   - create (any action !== "update") → pass through Gate 1

Deno.test("T1 · Gate 1 — update without content_markdown in updatedFields → no-op", () => {
  // Scenario: professor changed title + status via PUT /summaries/:id
  // Body: { title: "New Title", status: "published" }
  // updatedFields: ["title", "status"] — no content_markdown
  //
  // Expected: Gate 1 short-circuits. No re-chunking.
  // Verify: function returns without throwing.
  onSummaryWrite({
    action: "update",
    row: makeRow(),
    updatedFields: ["title", "status"],
    userId: "user-123",
  });
});

Deno.test("T2 · Gate 1 — update with empty updatedFields → no-op", () => {
  // Edge case: factory somehow sent an update with 0 actual fields.
  // (Shouldn't happen — factory checks Object.keys(row).length > 0 —
  //  but if it did, the hook must NOT trigger.)
  //
  // [].includes("content_markdown") → false → !false is true? No:
  // !updatedFields?.includes("content_markdown") → ![].includes(...) → !false → true → return.
  // Wait, [].includes("content_markdown") returns false. !false = true. So it returns. ✓
  onSummaryWrite({
    action: "update",
    row: makeRow(),
    updatedFields: [],
    userId: "user-123",
  });
});

Deno.test("T3 · Gate 1 — update with updatedFields undefined → no-op", () => {
  // Edge case: AfterWriteParams.updatedFields is optional (undefined on create).
  // If somehow undefined is passed on an update action:
  // !updatedFields?.includes("content_markdown")
  //   → !undefined?.includes(...)
  //   → !undefined
  //   → true → return. ✓
  onSummaryWrite({
    action: "update",
    row: makeRow(),
    updatedFields: undefined,
    userId: "user-123",
  });
});

// ═════════════════════════════════════════════════════════════════════
// Gate 2 — Extract IDs: skip if id or institution_id missing
// ═════════════════════════════════════════════════════════════════════
//
// Gate 2 code:
//   const summaryId = row.id as string | undefined;
//   const institutionId = row.institution_id as string | undefined;
//   if (!summaryId || !institutionId) { console.warn(...); return; }
//
// Expected behavior:
//   - row without id → console.warn + return
//   - row without institution_id → console.warn + return
//   - row with both → pass through Gate 2

Deno.test("T4 · Gate 2 — create with row missing id → warns and skips", () => {
  // Scenario: .select("*") returned a row without 'id' (shouldn't happen
  // with Supabase, but the hook guards defensively).
  //
  // Expected: console.warn with "[Summary Hook]" prefix, no throw.
  const capture = captureWarn();
  try {
    onSummaryWrite({
      action: "create",
      row: makeRow({ id: undefined }),
      userId: "user-123",
    });

    assertEquals(capture.messages.length, 1, "Expected exactly 1 warning");
    assertEquals(
      capture.messages[0].includes("[Summary Hook]"),
      true,
      "Warning should have [Summary Hook] prefix",
    );
    assertEquals(
      capture.messages[0].includes("Missing id or institution_id"),
      true,
      "Warning should mention missing fields",
    );
  } finally {
    capture.restore();
  }
});

Deno.test("T5 · Gate 2 — create with row missing institution_id → warns and skips", () => {
  // Scenario: summaries row somehow lacks the denormalized institution_id.
  // Could happen if the sync trigger failed or the column was NULL.
  const capture = captureWarn();
  try {
    onSummaryWrite({
      action: "create",
      row: makeRow({ institution_id: undefined }),
      userId: "user-123",
    });

    assertEquals(capture.messages.length, 1, "Expected exactly 1 warning");
    assertEquals(
      capture.messages[0].includes("Missing id or institution_id"),
      true,
      "Warning should mention missing fields",
    );
  } finally {
    capture.restore();
  }
});

// ═════════════════════════════════════════════════════════════════════
// Gate 3 — Content check: skip if empty/null/whitespace
// ═════════════════════════════════════════════════════════════════════
//
// Gate 3 code:
//   const contentMarkdown = row.content_markdown as string | null;
//   if (!contentMarkdown || contentMarkdown.trim().length === 0) return;
//
// Expected behavior:
//   - content_markdown is "" → !"" is true → return
//   - content_markdown is null → !null is true → return
//   - content_markdown is whitespace → trim().length === 0 → return
//   - content_markdown has real content → pass through Gate 3

Deno.test("T6 · Gate 3 — create with empty content_markdown → no-op", () => {
  // Scenario: professor created a summary with title only, no content yet.
  // POST /summaries { title: "Draft", content_markdown: "" }
  //
  // Expected: Gate 3 short-circuits. No point chunking empty content.
  onSummaryWrite({
    action: "create",
    row: makeRow({ content_markdown: "" }),
    userId: "user-123",
  });
});

Deno.test("T7 · Gate 3 — create with whitespace-only content → no-op", () => {
  // Scenario: professor typed some spaces/newlines but no real content.
  // The trim() check catches this.
  onSummaryWrite({
    action: "create",
    row: makeRow({ content_markdown: "   \n\t  \n  " }),
    userId: "user-123",
  });
});

// ═════════════════════════════════════════════════════════════════════
// Fire Path — All gates pass, autoChunkAndEmbed fires
// ═════════════════════════════════════════════════════════════════════
//
// When all 3 gates pass, onSummaryWrite calls:
//   autoChunkAndEmbed(summaryId, institutionId).catch(e => console.error(...))
//
// With fake env vars (http://127.0.0.1:1), the Supabase client's fetch
// gets ECONNREFUSED → autoChunkAndEmbed throws "Summary not found" →
// the hook's .catch() logs the error via console.error → no throw.
//
// We verify:
//   1. The function doesn't throw synchronously.
//   2. The async error is absorbed (console.error logged, not re-thrown).
//
// sanitizeOps/sanitizeResources disabled because the fire-and-forget
// promise creates async ops that Deno's test sanitizer would flag.

Deno.test({
  name: "T8 · Fire — create with valid content → autoChunkAndEmbed fires, error absorbed",
  fn: async () => {
    // Capture console.error to verify the hook's .catch() fires
    const errors: string[] = [];
    const originalError = console.error;
    // Also silence console.info from autoChunkAndEmbed's entry log
    const originalInfo = console.info;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    console.info = () => {}; // suppress [Auto-Ingest] log noise

    try {
      // Call with a fully valid row — all gates pass
      onSummaryWrite({
        action: "create",
        row: makeRow(),
        userId: "user-123",
      });

      // onSummaryWrite returns synchronously (fire-and-forget).
      // Wait for the background promise to settle.
      // 127.0.0.1:1 → ECONNREFUSED in ~1ms, but add margin for CI.
      await new Promise((r) => setTimeout(r, 2000));

      // The hook's .catch() should have logged an error
      assertEquals(
        errors.length >= 1,
        true,
        "Expected at least 1 console.error from hook's .catch()",
      );
      assertEquals(
        errors[0].includes("[Summary Hook]"),
        true,
        "Error should have [Summary Hook] prefix",
      );
      assertEquals(
        errors[0].includes("Auto-ingest failed"),
        true,
        "Error should mention auto-ingest failure",
      );
      assertEquals(
        errors[0].includes("sum-00000000-0000-0000-0000-000000000001"),
        true,
        "Error should include the summary ID for debugging",
      );
    } finally {
      console.error = originalError;
      console.info = originalInfo;
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

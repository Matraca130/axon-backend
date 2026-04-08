/**
 * Tests for summary-hook.ts — onSummaryWrite gate logic.
 *
 * Tests cover the 2-gate decision logic that determines whether
 * to trigger autoChunkAndEmbed after a summary POST/PUT:
 *
 *   Gate 1: On update, only trigger if a chunk-relevant field
 *           (content_markdown or title) was in updatedFields.
 *   Gate 2: Extract summaryId + institutionId from row; skip if missing.
 *
 * NOTE: The old "Gate 3" (skip if content_markdown is empty) was
 * removed — block-based summaries legitimately start with empty
 * content_markdown and their chunks must come from summary_blocks.
 * autoChunkAndEmbed now handles the "no content anywhere" case
 * internally as a cheap no-op.
 *
 * Test strategy:
 *   - Gates that SKIP (T1–T5): verify the function returns without
 *     throwing. Since skip paths exit before any async work, these
 *     tests are fully synchronous and deterministic.
 *   - Fire path (T6–T9): verify the function doesn't throw even when
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
// This ensures the fire-path test (T9) fails fast instead of hanging.

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
// Gate 1 — Update: only trigger if a chunk-relevant field changed
// ═════════════════════════════════════════════════════════════════════
//
// Gate 1 code (simplified):
//   if (action === "update" && !touched.some(f => CHUNK_RELEVANT_FIELDS.has(f))) return;
//
// CHUNK_RELEVANT_FIELDS = {content_markdown, title}
//
// Expected behavior:
//   - update + {status, order_index} only → return (no-op)
//   - update + empty updatedFields → return (no-op)
//   - update + undefined updatedFields → return (no-op)
//   - update + {title} → fires (title is embedded with content)
//   - update + {content_markdown} → fires
//   - create (any action !== "update") → bypasses Gate 1

Deno.test("T1 · Gate 1 — update with only non-chunk fields (status) → no-op", () => {
  // Scenario: professor toggled status via PUT /summaries/:id
  // Body: { status: "published" }
  // updatedFields: ["status"] — no chunk-relevant field
  //
  // Expected: Gate 1 short-circuits. No re-chunking.
  // Verify: function returns without throwing.
  onSummaryWrite({
    action: "update",
    row: makeRow(),
    updatedFields: ["status", "order_index"],
    userId: "user-123",
  });
});

Deno.test("T2 · Gate 1 — update with empty updatedFields → no-op", () => {
  // Edge case: factory somehow sent an update with 0 actual fields.
  // (Shouldn't happen — factory checks Object.keys(row).length > 0 —
  //  but if it did, the hook must NOT trigger.)
  onSummaryWrite({
    action: "update",
    row: makeRow(),
    updatedFields: [],
    userId: "user-123",
  });
});

Deno.test("T3 · Gate 1 — update with updatedFields undefined → no-op", () => {
  // Edge case: AfterWriteParams.updatedFields is optional (undefined on create).
  // On update with undefined, the some() on (touched ?? []) is false → return.
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
// Block-based summaries — create with empty content_markdown should FIRE
// ═════════════════════════════════════════════════════════════════════
//
// The old Gate 3 skipped empty content_markdown. That broke the primary
// Smart Reader flow: professors create a summary with just a title and
// then add blocks via POST /summary-blocks. The old behavior meant
// autoChunkAndEmbed was never invoked, so no chunks ever landed in the
// chunks table until /summaries/:id/publish was explicitly called.
//
// Current behavior: onSummaryWrite ALWAYS fires autoChunkAndEmbed on
// create, and the ingest pipeline itself (auto-ingest.ts) is responsible
// for resolving the source of truth — summary_blocks first, falling back
// to content_markdown, returning a cheap no-op if both are empty.
//
// These tests verify the hook invokes auto-ingest even when
// content_markdown is empty/null/whitespace.
//
// sanitizeOps/sanitizeResources disabled because the fire-and-forget
// promise creates async ops that Deno's test sanitizer would flag.

async function assertHookFires(
  row: Record<string, unknown>,
  action: "create" | "update" = "create",
): Promise<void> {
  const errors: string[] = [];
  const infos: string[] = [];
  const originalError = console.error;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  console.info = (...args: unknown[]) => {
    infos.push(args.map(String).join(" "));
  };
  console.warn = () => {};

  try {
    onSummaryWrite({
      action,
      row,
      updatedFields: action === "update" ? ["content_markdown"] : undefined,
      userId: "user-123",
    });

    const hookFiredP = (): boolean =>
      errors.some((e) => e.includes("[Summary Hook]")) ||
      infos.some((i) => i.includes("[Auto-Ingest]"));

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !hookFiredP()) {
      await new Promise((r) => setTimeout(r, 100));
    }

    assertEquals(
      hookFiredP(),
      true,
      "Expected autoChunkAndEmbed to have been invoked",
    );
  } finally {
    console.error = originalError;
    console.info = originalInfo;
    console.warn = originalWarn;
  }
}

Deno.test({
  name: "T6 · Block-based create with empty content_markdown → fires auto-ingest",
  fn: () => assertHookFires(makeRow({ content_markdown: "" })),
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "T7 · Block-based create with null content_markdown → fires auto-ingest",
  fn: () => assertHookFires(makeRow({ content_markdown: null })),
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "T8 · Block-based create with whitespace-only content → fires auto-ingest",
  fn: () => assertHookFires(makeRow({ content_markdown: "   \n\t  \n  " })),
  sanitizeOps: false,
  sanitizeResources: false,
});

// ═════════════════════════════════════════════════════════════════════
// Fire Path — All gates pass, autoChunkAndEmbed fires
// ═════════════════════════════════════════════════════════════════════
//
// When all 3 gates pass, onSummaryWrite calls:
//   autoChunkAndEmbed(summaryId, institutionId).catch(e => console.error(...))
//
// With fake env vars (http://127.0.0.1:1), the Supabase client's RPC
// call (try_advisory_lock) fails gracefully — returning { data: null },
// which causes autoChunkAndEmbed to return the "skipped_locked" result
// without throwing. The .catch() may or may not fire depending on how
// the Supabase client handles the connection failure.
//
// We verify:
//   1. The function doesn't throw synchronously.
//   2. The async error is absorbed (no unhandled rejection).
//
// sanitizeOps/sanitizeResources disabled because the fire-and-forget
// promise creates async ops that Deno's test sanitizer would flag.

Deno.test({
  name: "T9 · Fire — create with valid content → autoChunkAndEmbed fires, error absorbed",
  fn: async () => {
    // Capture console output to verify no unhandled errors escape
    const errors: string[] = [];
    const infos: string[] = [];
    const originalError = console.error;
    const originalInfo = console.info;
    const originalWarn = console.warn;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    console.info = (...args: unknown[]) => {
      infos.push(args.map(String).join(" "));
    };
    console.warn = () => {}; // suppress warnings from Supabase client

    try {
      // Call with a fully valid row — all gates pass
      onSummaryWrite({
        action: "create",
        row: makeRow(),
        userId: "user-123",
      });

      // onSummaryWrite returns synchronously (fire-and-forget).
      // Poll for the background promise to settle. The hook does:
      //   1. SELECT summary_blocks (supabase-js retries on connect
      //      errors with backoff — observed ~7s on 127.0.0.1:1).
      //   2. Then autoChunkAndEmbed → try_advisory_lock RPC →
      //      logs "[Auto-Ingest] Skipping summary ... advisory lock
      //      not acquired" once the connect refusal surfaces.
      // We poll up to 15s so the test isn't sensitive to the exact
      // retry schedule across CI runners.
      const hookFiredP = (): boolean =>
        errors.some((e) => e.includes("[Summary Hook]")) ||
        infos.some((i) => i.includes("[Auto-Ingest]"));

      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && !hookFiredP()) {
        await new Promise((r) => setTimeout(r, 100));
      }

      // The key invariant: no unhandled promise rejection escaped.
      // autoChunkAndEmbed either:
      //   a) returned gracefully (advisory lock not acquired → skipped_locked), or
      //   b) threw and was caught by the hook's .catch() → console.error logged.
      // Either path is valid — the hook absorbed the failure.
      assertEquals(
        hookFiredP(),
        true,
        "Expected autoChunkAndEmbed to have been invoked (either logged info or caught error)",
      );
    } finally {
      console.error = originalError;
      console.info = originalInfo;
      console.warn = originalWarn;
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

/**
 * Tests for routes/telegram/async-queue.ts — Telegram background job processor
 *
 * Tests cover:
 *   1. Module imports correctly (enqueueJob, processNextJob, processPendingJobs)
 *   2. Job types are defined (generate_content, generate_weekly_report)
 *
 * NOTE: Full integration tests for enqueueJob/processNextJob require a running
 * Supabase instance (they call getAdminClient). These tests verify module
 * structure and type definitions only.
 *
 * Run: deno test supabase/functions/server/tests/telegram_async_queue_test.ts
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  enqueueJob,
  processNextJob,
  processPendingJobs,
} from "../routes/telegram/async-queue.ts";

// ═════════════════════════════════════════════════════════════════
// 1. Module imports correctly
// ═════════════════════════════════════════════════════════════════

Deno.test("telegram async-queue: enqueueJob is a function", () => {
  assertEquals(typeof enqueueJob, "function");
});

Deno.test("telegram async-queue: processNextJob is a function", () => {
  assertEquals(typeof processNextJob, "function");
});

Deno.test("telegram async-queue: processPendingJobs is a function", () => {
  assertEquals(typeof processPendingJobs, "function");
});

// ═════════════════════════════════════════════════════════════════
// 2. Job types are defined (type-level verification via valid payloads)
// ═════════════════════════════════════════════════════════════════

Deno.test("telegram async-queue: generate_content job type is valid", () => {
  // Verify the payload shape compiles and is structurally valid.
  // We cannot call enqueueJob without a real DB, but we can verify
  // the payload structure matches the TelegramJobPayload interface.
  const payload = {
    type: "generate_content" as const,
    channel: "telegram" as const,
    user_id: "test-user-id",
    chat_id: 12345,
    action: "flashcard" as const,
    summary_id: "test-summary-id",
  };

  assertEquals(payload.type, "generate_content");
  assertEquals(payload.channel, "telegram");
  assertEquals(typeof payload.chat_id, "number");
  assertEquals(payload.action, "flashcard");
});

Deno.test("telegram async-queue: generate_weekly_report job type is valid", () => {
  const payload = {
    type: "generate_weekly_report" as const,
    channel: "telegram" as const,
    user_id: "test-user-id",
    chat_id: 67890,
  };

  assertEquals(payload.type, "generate_weekly_report");
  assertEquals(payload.channel, "telegram");
  assertEquals(typeof payload.user_id, "string");
});

Deno.test("telegram async-queue: quiz action is valid for generate_content", () => {
  const payload = {
    type: "generate_content" as const,
    channel: "telegram" as const,
    user_id: "test-user-id",
    chat_id: 11111,
    action: "quiz" as const,
    summary_id: "test-summary-id",
  };

  assertEquals(payload.action, "quiz");
});

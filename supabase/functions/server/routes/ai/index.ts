/**
 * routes/ai/index.ts — AI module combiner
 *
 * Mounts all AI sub-modules into a single Hono router.
 *
 * Sub-modules:
 *   generate.ts          — POST  /ai/generate
 *   generate-smart.ts    — POST  /ai/generate-smart        (Fase 8A)
 *   report.ts            — POST  /ai/report                (Fase 8B)
 *                          PATCH /ai/report/:id             (Fase 8B)
 *   report-dashboard.ts  — GET   /ai/report-stats           (Fase 8C)
 *                          GET   /ai/reports                (Fase 8C)
 *   pre-generate.ts      — POST  /ai/pre-generate           (Fase 8D)
 *   ingest.ts            — POST  /ai/ingest-embeddings
 *   re-chunk.ts          — POST  /ai/re-chunk               (Fase 5)
 *   chat.ts              — POST  /ai/rag-chat
 *   feedback.ts          — PATCH /ai/rag-feedback (T-03)
 *   analytics.ts         — GET   /ai/rag-analytics + /ai/embedding-coverage (T-03)
 *   ingest-pdf.ts        — POST  /ai/ingest-pdf              (Fase 7)
 *
 * PHASE-A2 CLEANUP: Removed temporary routes:
 *   - list-models.ts     (diagnostic, no longer needed)
 *   - re-embed-all.ts    (D57 migration tool, completed)
 *
 * INC-3 FIX: Added AI-specific rate limit middleware (20 req/hour).
 * Uses the distributed check_rate_limit() RPC from migration 20260303_02.
 * Applies to Gemini-consuming POST routes (generate, generate-smart,
 * ingest, re-chunk, rag-chat, ingest-pdf).
 *
 * P6 FIX: POST /ai/report excluded from rate limit (no Gemini cost).
 * D9 FIX: POST /ai/pre-generate has own rate limit bucket.
 * Fase 7: Added ingest-pdf sub-module (PDF upload + extraction).
 *
 * D1 FIX (debate-001/002): Rate limiter changed from FAIL-OPEN to FAIL-CLOSED.
 * Both error paths (RPC error + exception) now return 503 + Retry-After: 30
 * instead of silently allowing the request through.
 * Known limitation: /ai/report and /ai/pre-generate bypass rate limit intentionally (H10).
 */

import { Hono } from "npm:hono";
import type { Context, Next } from "npm:hono";
import { aiGenerateRoutes } from "./generate.ts";
import { aiGenerateSmartRoutes } from "./generate-smart.ts";
import { aiReportRoutes } from "./report.ts";
import { aiReportDashboardRoutes } from "./report-dashboard.ts";
import { aiPreGenerateRoutes } from "./pre-generate.ts";
import { aiIngestRoutes } from "./ingest.ts";
import { aiReChunkRoutes } from "./re-chunk.ts";
import { aiChatRoutes } from "./chat.ts";
import { aiFeedbackRoutes } from "./feedback.ts";
import { aiAnalyticsRoutes } from "./analytics.ts";
import { aiIngestPdfRoutes } from "./ingest-pdf.ts";
import { authenticate, err, getAdminClient, PREFIX } from "../../db.ts";

const aiRoutes = new Hono();

// INC-3 FIX: AI-specific rate limit middleware (20 req/hour)
const AI_RATE_LIMIT = 20;
const AI_RATE_WINDOW_MS = 3600000;

/**
 * D1 FIX: FAIL-CLOSED rate limiter.
 *
 * Previously, both the error path (RPC failure) and catch path (exception)
 * silently allowed requests through (`return next()`). This meant that if
 * the rate limit RPC was down, ALL AI requests would bypass the limiter
 * — potentially incurring unlimited OpenAI/Gemini API costs.
 *
 * Now: all error paths return 503 + Retry-After: 30.
 * The happy path `return next()` is INSIDE the try block, after the
 * rate limit check passes, to prevent future fall-through bugs.
 */
async function aiRateLimitMiddleware(c: Context, next: Next) {
  if (c.req.method !== "POST") return next();

  const url = new URL(c.req.url);

  // P6 FIX: Skip /ai/report (no Gemini cost) — intentional bypass (H10)
  if (url.pathname.endsWith("/ai/report")) return next();
  // D9 FIX: Skip /ai/pre-generate (own rate limit bucket) — intentional bypass (H10)
  if (url.pathname.endsWith("/ai/pre-generate")) return next();

  try {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const userId = auth.user.id;

    const adminDb = getAdminClient();
    const { data, error } = await adminDb.rpc("check_rate_limit", {
      p_key: `ai:${userId}`,
      p_max_requests: AI_RATE_LIMIT,
      p_window_ms: AI_RATE_WINDOW_MS,
    });

    // D1 FIX: FAIL-CLOSED — RPC error blocks the request (was: return next())
    if (error) {
      console.error(
        `[AI RateLimit] RPC failed: ${error.message}. BLOCKING request (fail-closed).`,
      );
      c.header("Retry-After", "30");
      return c.json(
        { error: "rate_limit_unavailable", retry_after: 30 },
        503,
      );
    }

    if (data && !data.allowed) {
      const retryAfter = Math.ceil((data.retry_after_ms || 0) / 1000);
      c.header("Retry-After", String(retryAfter));
      return c.json(
        {
          error: `AI rate limit exceeded: max ${AI_RATE_LIMIT} requests per hour.`,
          retry_after: retryAfter,
        },
        429,
      );
    }

    // Happy path: rate limit check passed — INSIDE try block (D1 refactor)
    return next();
  } catch (e) {
    // D1 FIX: FAIL-CLOSED — exception blocks the request (was: return next())
    console.error(
      `[AI RateLimit] Exception: ${(e as Error).message}. BLOCKING request (fail-closed).`,
    );
    c.header("Retry-After", "30");
    return c.json(
      { error: "rate_limit_unavailable", retry_after: 30 },
      503,
    );
  }
}

aiRoutes.use(`${PREFIX}/ai/*`, aiRateLimitMiddleware);

// Mount sub-modules
aiRoutes.route("/", aiGenerateRoutes);
aiRoutes.route("/", aiGenerateSmartRoutes);       // Fase 8A
aiRoutes.route("/", aiReportRoutes);              // Fase 8B
aiRoutes.route("/", aiReportDashboardRoutes);     // Fase 8C
aiRoutes.route("/", aiPreGenerateRoutes);         // Fase 8D
aiRoutes.route("/", aiIngestRoutes);
aiRoutes.route("/", aiReChunkRoutes);             // Fase 5
aiRoutes.route("/", aiChatRoutes);
aiRoutes.route("/", aiFeedbackRoutes);            // T-03
aiRoutes.route("/", aiAnalyticsRoutes);            // T-03
aiRoutes.route("/", aiIngestPdfRoutes);            // Fase 7

export { aiRoutes };

/**
 * routes/ai/index.ts — AI module combiner
 *
 * Mounts all AI sub-modules into a single Hono router.
 *
 * Sub-modules:
 *   generate.ts        — POST  /ai/generate
 *   generate-smart.ts  — POST  /ai/generate-smart        (Fase 8A)
 *   report.ts          — POST  /ai/report                (Fase 8B)
 *                        PATCH /ai/report/:id             (Fase 8B)
 *   ingest.ts          — POST  /ai/ingest-embeddings
 *   re-chunk.ts        — POST  /ai/re-chunk               (Fase 5)
 *   chat.ts            — POST  /ai/rag-chat
 *   list-models.ts     — GET   /ai/list-models (diagnostic)
 *   feedback.ts        — PATCH /ai/rag-feedback (T-03)
 *   analytics.ts       — GET   /ai/rag-analytics + /ai/embedding-coverage (T-03)
 *
 * INC-3 FIX: Added AI-specific rate limit middleware (20 req/hour).
 * Uses the distributed check_rate_limit() RPC from migration 20260303_02.
 * Applies to Gemini-consuming POST routes (generate, generate-smart,
 * ingest, re-chunk, rag-chat).
 *
 * P6 FIX: POST /ai/report is excluded from rate limit — it doesn't
 * call Gemini, so it shouldn't consume the AI generation quota.
 *
 * T-03: Added feedback and analytics sub-modules (Fase 4).
 * Fase 8A: Added generate-smart sub-module (adaptive generation).
 * Fase 8B: Added report sub-module (content quality reports).
 */

import { Hono } from "npm:hono";
import type { Context, Next } from "npm:hono";
import { aiGenerateRoutes } from "./generate.ts";
import { aiGenerateSmartRoutes } from "./generate-smart.ts";
import { aiReportRoutes } from "./report.ts";
import { aiIngestRoutes } from "./ingest.ts";
import { aiReChunkRoutes } from "./re-chunk.ts";
import { aiChatRoutes } from "./chat.ts";
import { aiListModelsRoutes } from "./list-models.ts";
import { aiFeedbackRoutes } from "./feedback.ts";
import { aiAnalyticsRoutes } from "./analytics.ts";
import { authenticate, err, getAdminClient, PREFIX } from "../../db.ts";

const aiRoutes = new Hono();

// ── INC-3 FIX: AI-specific rate limit middleware ─────────────────
// 20 AI requests per hour per user.
// Uses the distributed check_rate_limit() RPC (migration 20260303_02)
// which works correctly across multiple Deno isolates.
//
// Only applies to Gemini-consuming POST routes (generate, generate-smart,
// ingest, re-chunk, rag-chat).
//
// Excluded (no Gemini API cost):
//   GET  /ai/list-models, /ai/rag-analytics, /ai/embedding-coverage
//   PATCH /ai/rag-feedback, /ai/report/:id
//   POST  /ai/report  (P6 FIX: reports don't call Gemini)
const AI_RATE_LIMIT = 20;          // max requests per window
const AI_RATE_WINDOW_MS = 3600000; // 1 hour in milliseconds

async function aiRateLimitMiddleware(c: Context, next: Next) {
  // Only rate-limit POST requests (the ones that call Gemini)
  if (c.req.method !== "POST") return next();

  // P6 FIX: Skip rate limit for /ai/report — no Gemini cost.
  // Reports are a feedback mechanism, not a generation action.
  // Without this exclusion, reporting would consume the student's
  // AI generation quota, disincentivizing quality feedback.
  const url = new URL(c.req.url);
  if (url.pathname.endsWith("/ai/report")) return next();

  try {
    // Extract user ID from JWT (lightweight decode, no DB call)
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const userId = auth.user.id;

    // Check rate limit via distributed RPC
    const adminDb = getAdminClient();
    const { data, error } = await adminDb.rpc("check_rate_limit", {
      p_key: `ai:${userId}`,
      p_max_requests: AI_RATE_LIMIT,
      p_window_ms: AI_RATE_WINDOW_MS,
    });

    if (error) {
      // If rate limit check fails, log but don't block
      console.warn(`[AI RateLimit] RPC failed: ${error.message}. Allowing request.`);
      return next();
    }

    if (data && !data.allowed) {
      return err(
        c,
        `AI rate limit exceeded: max ${AI_RATE_LIMIT} requests per hour. ` +
        `Try again in ${Math.ceil((data.retry_after_ms || 0) / 1000)}s.`,
        429,
      );
    }
  } catch (e) {
    // Graceful degradation: if anything fails, allow the request
    console.warn(`[AI RateLimit] Exception: ${(e as Error).message}. Allowing request.`);
  }

  return next();
}

// Apply rate limit middleware to all AI routes
aiRoutes.use(`${PREFIX}/ai/*`, aiRateLimitMiddleware);

// Mount sub-modules
aiRoutes.route("/", aiGenerateRoutes);
aiRoutes.route("/", aiGenerateSmartRoutes); // Fase 8A: POST /ai/generate-smart
aiRoutes.route("/", aiReportRoutes);        // Fase 8B: POST /ai/report + PATCH /ai/report/:id
aiRoutes.route("/", aiIngestRoutes);
aiRoutes.route("/", aiReChunkRoutes);       // Fase 5: POST /ai/re-chunk
aiRoutes.route("/", aiChatRoutes);
aiRoutes.route("/", aiListModelsRoutes);
aiRoutes.route("/", aiFeedbackRoutes);      // T-03: PATCH /ai/rag-feedback
aiRoutes.route("/", aiAnalyticsRoutes);      // T-03: GET /ai/rag-analytics + /ai/embedding-coverage

export { aiRoutes };

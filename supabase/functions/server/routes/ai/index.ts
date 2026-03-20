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
 *   realtime-session.ts  — POST  /ai/realtime-session         (Voice Call)
 *   analyze-graph.ts       — POST  /ai/analyze-knowledge-graph  (Mindmap AI)
 *   suggest-connections.ts — POST  /ai/suggest-student-connections (Mindmap AI)
 *   student-weak-points.ts — GET   /ai/student-weak-points     (Mindmap AI)
 *   schedule-agent.ts     — POST  /ai/schedule-agent          (Study Schedule AI)
 *                            GET   /ai/schedule-logs           (Schedule Agent Logs)
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
import { aiRealtimeRoutes } from "./realtime-session.ts";
import { aiAnalyzeGraphRoutes } from "./analyze-graph.ts";
import { aiSuggestConnectionsRoutes } from "./suggest-connections.ts";
import { aiWeakPointsRoutes } from "./student-weak-points.ts";
import { aiScheduleAgentRoutes } from "./schedule-agent.ts";
import { authenticate, err, getAdminClient, PREFIX } from "../../db.ts";

const aiRoutes = new Hono();

// INC-3 FIX: AI-specific rate limit middleware (20 req/hour)
const AI_RATE_LIMIT = 20;
const AI_RATE_WINDOW_MS = 3600000;

async function aiRateLimitMiddleware(c: Context, next: Next) {
  if (c.req.method !== "POST") return next();

  const url = new URL(c.req.url);

  // P6 FIX: Skip /ai/report (no Gemini cost)
  if (url.pathname.endsWith("/ai/report")) return next();
  // D9 FIX: Skip /ai/pre-generate (own rate limit bucket)
  if (url.pathname.endsWith("/ai/pre-generate")) return next();
  // Schedule agent has own rate limit bucket (10/hour)
  if (url.pathname.endsWith("/ai/schedule-agent")) return next();
  // Voice calls use ephemeral tokens, no Gemini cost — own session management
  if (url.pathname.endsWith("/ai/realtime-session")) return next();

  try {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const userId = auth.user.id;
    c.set("userId", userId);

    const adminDb = getAdminClient();
    const { data, error } = await adminDb.rpc("check_rate_limit", {
      p_key: `ai:${userId}`,
      p_max_requests: AI_RATE_LIMIT,
      p_window_ms: AI_RATE_WINDOW_MS,
    });

    // Fail-closed: deny on RPC error to prevent unmetered API usage
    if (error) {
      console.error(`[AI RateLimit] RPC failed: ${error.message}. Denying request.`);
      return err(c, "Could not verify rate limit status. Please try again later.", 500);
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
    console.error(`[AI RateLimit] Exception: ${(e as Error).message}. Denying request.`);
    return err(c, "Could not verify rate limit status. Please try again later.", 500);
  }

  return next();
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
aiRoutes.route("/", aiRealtimeRoutes);             // Voice Call (Realtime API)
aiRoutes.route("/", aiAnalyzeGraphRoutes);         // Mindmap AI (Knowledge Graph)
aiRoutes.route("/", aiSuggestConnectionsRoutes);   // Mindmap AI (Suggest Connections)
aiRoutes.route("/", aiWeakPointsRoutes);           // Mindmap AI (Student Weak Points)
aiRoutes.route("/", aiScheduleAgentRoutes);        // Study Schedule AI Agent

export { aiRoutes };

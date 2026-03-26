/**
 * index.ts — Hono server entrypoint for Axon v4.4
 *
 * O-8 FIX: Rate limiting middleware added (120 req/min/user).
 * RAG FIX: AI routes mounted (generate, ingest, chat).
 * BUG-004 FIX: CORS restricted to specific origins (was wildcard "*").
 * D57: Health check now reports openai status alongside gemini.
 * GAMIFICATION: Sprint 1 — gamificationRoutes mounted.
 * PR #101: Modularized gamificationRoutes from monolithic 53KB file.
 * PR #102: Renamed .tsx → .ts (no JSX), deduplicated calculateLevel.
 * PR #103: Modularized billing → routes/billing/, study-queue → routes/study-queue/.
 *   CORS restricted to Vercel + localhost origins (BUG-004).
 */

import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { compress } from "npm:hono/compress";
import { logger } from "npm:hono/logger";
import { PREFIX } from "./db.ts";
import { rateLimitMiddleware } from "./rate-limit.ts";

import { authRoutes } from "./routes-auth.ts";
import { memberRoutes } from "./routes/members/index.ts";
import { content } from "./routes/content/index.ts";
import { studentRoutes } from "./routes-student.ts";
import { studyRoutes } from "./routes/study/index.ts";
import { studyQueueRoutes } from "./routes/study-queue/index.ts";
import { modelRoutes } from "./routes-models.ts";
import { planRoutes } from "./routes/plans/index.ts";
import { billingRoutes } from "./routes/billing/index.ts";
import { muxRoutes } from "./routes/mux/index.ts";
import { searchRoutes } from "./routes/search/index.ts";
import { storageRoutes } from "./routes-storage.ts";
import { settingsRoutes } from "./routes/settings/index.ts";
import { aiRoutes } from "./routes/ai/index.ts";
import { whatsappRoutes } from "./routes/whatsapp/index.ts";
import { telegramRoutes } from "./routes/telegram/index.ts";
import { gamificationRoutes } from "./routes/gamification/index.ts";

const app = new Hono();

// ─── Middleware ───────────────────────────────────────────────────

// BUG-004 FIX: CORS restricted to known origins.
// Add your production Vercel URL(s) below.
const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:3000",
  "https://axon-frontend.vercel.app",
  "https://numero1-sseki-2325-55.vercel.app",
];

// Vercel preview deploy patterns — only exact project prefixes allowed
// Matches: https://<project>-<deployId>-<team>.vercel.app
const VERCEL_PREVIEW_RE = /^https:\/\/(numero1-sseki-2325-55|axon-frontend)-[a-z0-9-]+\.vercel\.app$/;

function getAllowedOrigin(origin: string): string {
  if (!origin) return "";
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  if (VERCEL_PREVIEW_RE.test(origin)) return origin;
  return "";
}

// Explicit preflight handler — Supabase gateway may not forward OPTIONS to Hono middleware
app.options("*", (c) => {
  const origin = getAllowedOrigin(c.req.raw.headers.get("Origin") ?? "");
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Access-Token",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Max-Age": "86400",
    },
  });
});

app.use("*", logger(console.warn));

// BUG-004 FIX: CORS restricted to allowed origins + Vercel previews.
app.use(
  "/*",
  cors({
    origin: (origin) => getAllowedOrigin(origin),
    allowHeaders: ["Content-Type", "Authorization", "X-Access-Token"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    exposeHeaders: ["Content-Length"],
    maxAge: 86400,
  }),
);

// Security headers (CSP is handled by Vercel, not the API)
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
});

// Gzip compression (after CORS, before routes)
app.use("*", compress());

// O-8 FIX: Rate limiting (after CORS, before routes)
app.use("*", rateLimitMiddleware);

// ─── Health Check ────────────────────────────────────────────────
// PF-10 FIX: Added gemini status (does NOT expose the actual key)
// D57: Added openai status for embedding migration

app.get(`${PREFIX}/health`, (c) => {
  return c.json({
    status: "ok",
    version: "4.5",
    timestamp: new Date().toISOString(),
    services: {
      gemini: !!Deno.env.get("GEMINI_API_KEY"),
      openai: !!Deno.env.get("OPENAI_API_KEY"),
      claude: !!Deno.env.get("ANTHROPIC_API_KEY"),
      whatsapp: Deno.env.get("WHATSAPP_ENABLED") === "true",
      telegram: Deno.env.get("TELEGRAM_ENABLED") === "true",
    },
  });
});

// ─── Mount Route Modules ─────────────────────────────────────────

app.route("/", authRoutes);
app.route("/", memberRoutes);
app.route("/", content);
app.route("/", studentRoutes);
app.route("/", studyRoutes);
app.route("/", studyQueueRoutes);
app.route("/", modelRoutes);
app.route("/", planRoutes);
app.route("/", billingRoutes);
app.route("/", muxRoutes);
app.route("/", searchRoutes);
app.route("/", storageRoutes);
app.route("/", settingsRoutes);
app.route("/", aiRoutes);
app.route("/", whatsappRoutes);
app.route("/", telegramRoutes);
app.route("/", gamificationRoutes);

// ─── Catch-all 404 ───────────────────────────────────────────────

app.all("*", (c) => {
  console.warn(`[404] ${c.req.method} ${c.req.path}`);
  return c.json(
    {
      error: "Route not found",
      path: c.req.path,
      method: c.req.method,
      hint: "Check that the route path and HTTP method are correct.",
    },
    404,
  );
});

Deno.serve(app.fetch);

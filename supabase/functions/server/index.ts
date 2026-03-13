/**
 * index.ts — Hono server entrypoint for Axon v4.4
 *
 * O-8 FIX: Rate limiting middleware added (120 req/min/user).
 * RAG FIX: AI routes mounted (generate, ingest, chat).
 * BUG-004 FIX: CORS restricted to specific origins.
 * D57: Health check now reports openai status alongside gemini.
 * GAMIFICATION: Sprint 1 — gamificationRoutes mounted.
 * PR #101: Modularized gamificationRoutes from monolithic 53KB file.
 * PR #102: Renamed .tsx → .ts (no JSX), deduplicated calculateLevel.
 * PR #103: Modularized billing → routes/billing/, study-queue → routes/study-queue/.
 *   CORS restricted to Vercel + localhost origins (BUG-004).
 */

import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
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

app.use("*", logger(console.log));

// BUG-004 FIX: CORS restricted to known origins.
// Add your production Vercel URL(s) below.
const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:3000",
  "https://axon-frontend.vercel.app",
];

app.use(
  "/*",
  cors({
    origin: (origin) => {
      // Allow requests with no origin (e.g. server-to-server, Postman)
      if (!origin) return "*";
      // Allow any *.vercel.app subdomain for preview deployments
      if (origin.endsWith(".vercel.app")) return origin;
      // Allow explicitly listed origins
      if (ALLOWED_ORIGINS.includes(origin)) return origin;
      // Deny others
      return "";
    },
    allowHeaders: ["Content-Type", "Authorization", "X-Access-Token"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
  }),
);

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
  console.log(`[404] ${c.req.method} ${c.req.path}`);
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

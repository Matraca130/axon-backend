/**
 * index.ts — Hono server entrypoint for Axon v4.4
 *
 * O-8 FIX: Rate limiting middleware added (120 req/min/user).
 */

import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { logger } from "npm:hono/logger";
import { PREFIX } from "./db.ts";
import { rateLimitMiddleware } from "./rate-limit.ts";

import { authRoutes } from "./routes-auth.tsx";
import { memberRoutes } from "./routes-members.tsx";
import { content } from "./routes-content.tsx";
import { studentRoutes } from "./routes-student.tsx";
import { studyRoutes } from "./routes-study.tsx";
import { studyQueueRoutes } from "./routes-study-queue.tsx";
import { modelRoutes } from "./routes-models.tsx";
import { planRoutes } from "./routes-plans.tsx";
import { billingRoutes } from "./routes-billing.tsx";
import { muxRoutes } from "./routes-mux.ts";
import { searchRoutes } from "./routes-search.ts";
import { storageRoutes } from "./routes-storage.tsx";

const app = new Hono();

// ─── Middleware ──────────────────────────────────────────────────────

app.use("*", logger(console.log));

app.use(
  "/*",
  cors({
    origin: "*",
    allowHeaders: ["Content-Type", "Authorization", "X-Access-Token"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
  }),
);

// O-8 FIX: Rate limiting (after CORS, before routes)
app.use("*", rateLimitMiddleware);

// ─── Health Check ───────────────────────────────────────────────────

app.get(`${PREFIX}/health`, (c) => {
  return c.json({
    status: "ok",
    version: "4.4",
    timestamp: new Date().toISOString(),
  });
});

// ─── Mount Route Modules ────────────────────────────────────────────

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

// ─── Catch-all 404 ──────────────────────────────────────────────────

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

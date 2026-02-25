/**
 * index.ts — Hono server entrypoint for Axon v4.4
 *
 * Mounts all route modules on a single Hono app with CORS + logging.
 * Each route file creates its own Hono instance; they are composed here.
 *
 * Route modules (11):
 *   routes-auth     → /signup, /me
 *   routes-members  → /institutions, /memberships, /admin-scopes
 *   routes-content  → /courses .. /subtopics, /keyword-connections,
 *                     /kw-prof-notes, /reorder, /content-tree
 *   routes-student  → /flashcards, /quizzes, /quiz-questions, /videos,
 *                     /kw-student-notes, /text-annotations, /video-notes
 *   routes-study    → /study-sessions, /study-plans, /study-plan-tasks,
 *                     /reviews, /quiz-attempts, /reading-states,
 *                     /daily-activities, /student-stats,
 *                     /fsrs-states, /bkt-states
 *   routes-models   → /models-3d, /model-3d-pins, /model-3d-notes
 *   routes-plans    → /platform-plans, /institution-plans,
 *                     /plan-access-rules, /institution-subscriptions,
 *                     /ai-generations, /summary-diagnostics,
 *                     /content-access, /usage-today
 *   routes-billing  → /billing/checkout-session, /billing/portal-session,
 *                     /billing/subscription-status, /webhooks/stripe
 *   routes-mux      → /mux/create-upload, /webhooks/mux, /mux/playback-token,
 *                     /mux/track-view, /mux/video-stats, /mux/asset/:id
 *   routes-search   → /search, /trash, /restore/:table/:id
 *   routes-storage  → /storage/upload, /storage/signed-url, /storage/delete
 *   index (inline)  → /health
 */

import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { logger } from "npm:hono/logger";
import { PREFIX } from "./db.ts";

// Route modules
import { authRoutes } from "./routes-auth.tsx";
import { memberRoutes } from "./routes-members.tsx";
import { content } from "./routes-content.tsx";
import { studentRoutes } from "./routes-student.tsx";
import { studyRoutes } from "./routes-study.tsx";
import { modelRoutes } from "./routes-models.tsx";
import { planRoutes } from "./routes-plans.tsx";
import { billingRoutes } from "./routes-billing.tsx";
import { muxRoutes } from "./routes-mux.ts";
import { searchRoutes } from "./routes-search.ts";
import { storageRoutes } from "./routes-storage.tsx";

const app = new Hono();

// ─── Middleware ────────────────────────────────────────────────────────

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

// ─── Health Check ─────────────────────────────────────────────────────

app.get(`${PREFIX}/health`, (c) => {
  return c.json({
    status: "ok",
    version: "4.4",
    timestamp: new Date().toISOString(),
  });
});

// ─── Mount Route Modules ────────────────────────────────────────────
// Each module registers its routes with the full PREFIX already included,
// so we mount at "/" to pass through unchanged.

app.route("/", authRoutes);
app.route("/", memberRoutes);
app.route("/", content);
app.route("/", studentRoutes);
app.route("/", studyRoutes);
app.route("/", modelRoutes);
app.route("/", planRoutes);
app.route("/", billingRoutes);
app.route("/", muxRoutes);
app.route("/", searchRoutes);
app.route("/", storageRoutes);

// ─── Catch-all 404 ────────────────────────────────────────────────────
// Must be AFTER all route modules so it only matches unhandled paths.

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

// ─── Start Server ─────────────────────────────────────────────────────

Deno.serve(app.fetch);

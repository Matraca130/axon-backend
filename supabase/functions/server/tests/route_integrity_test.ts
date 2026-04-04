/**
 * route_integrity_test.ts — Route Registry Integrity Test
 *
 * Guards against silent route loss during merges/rebases.
 * If a route exists in production, it MUST be listed here.
 * Removing an entry from this file requires explicit justification.
 *
 * HOW IT WORKS:
 *   1. Imports every index router and standalone router
 *   2. Verifies each export is a Hono instance (not undefined/null)
 *   3. Verifies expected sub-module counts (route registrations)
 *   4. Verifies routes-student.ts has all expected CRUD slugs
 *
 * To add a new route: add it to the EXPECTED_* constants below.
 * To remove a route: remove it AND leave a comment explaining why.
 */

import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// ─── Route Imports ───────────────────────────────────────────────

// Top-level standalone routers
import { authRoutes } from "../routes-auth.ts";
import { studentRoutes } from "../routes-student.ts";
import { storageRoutes } from "../routes-storage.ts";
import { modelRoutes } from "../routes-models.ts";

// Module index routers
import { memberRoutes } from "../routes/members/index.ts";
import { content } from "../routes/content/index.ts";
import { studyRoutes } from "../routes/study/index.ts";
import { studyQueueRoutes } from "../routes/study-queue/index.ts";
import { planRoutes } from "../routes/plans/index.ts";
import { billingRoutes } from "../routes/billing/index.ts";
import { muxRoutes } from "../routes/mux/index.ts";
import { searchRoutes } from "../routes/search/index.ts";
import { settingsRoutes } from "../routes/settings/index.ts";
import { aiRoutes } from "../routes/ai/index.ts";
import { whatsappRoutes } from "../routes/whatsapp/index.ts";
import { telegramRoutes } from "../routes/telegram/index.ts";
import { gamificationRoutes } from "../routes/gamification/index.ts";
import { calendarRoutes } from "../routes/calendar/index.ts";
import { scheduleRoutes } from "../routes/schedule/index.ts";
import { adminRoutes } from "../routes/admin/index.ts";

// ─── Expected Route Registry ────────────────────────────────────
// These are the MINIMUM expected exports. Any merge that causes
// an import to become undefined will fail this test.

const TOP_LEVEL_ROUTERS = {
  authRoutes,
  studentRoutes,
  storageRoutes,
  modelRoutes,
  memberRoutes,
  content,
  studyRoutes,
  studyQueueRoutes,
  planRoutes,
  billingRoutes,
  muxRoutes,
  searchRoutes,
  settingsRoutes,
  aiRoutes,
  whatsappRoutes,
  telegramRoutes,
  gamificationRoutes,
  calendarRoutes,
  scheduleRoutes,
  adminRoutes,
} as const;

// ─── Expected CRUD slugs in routes-student.ts ───────────────────
// These slugs map to registerCrud() calls. If any disappear,
// a frontend CRUD endpoint silently breaks.

const EXPECTED_STUDENT_CRUD_SLUGS = [
  "flashcards",
  "my-flashcards",
  "quiz-questions",
  "quizzes",
  "videos",
  "kw-student-notes",
  "text-annotations",
  "video-notes",
];

// ─── Tests ──────────────────────────────────────────────────────

Deno.test("Route Integrity: all top-level routers are defined (not undefined/null)", () => {
  for (const [name, router] of Object.entries(TOP_LEVEL_ROUTERS)) {
    assertExists(router, `Router "${name}" is undefined — was it deleted or renamed in a merge?`);
  }
});

Deno.test("Route Integrity: all top-level routers are Hono instances", () => {
  for (const [name, router] of Object.entries(TOP_LEVEL_ROUTERS)) {
    assertEquals(
      typeof (router as any).fetch,
      "function",
      `Router "${name}" does not have a .fetch method — it may not be a Hono instance`,
    );
  }
});

Deno.test("Route Integrity: routes-student.ts contains all expected CRUD slugs", async () => {
  // Read the source file and check for each slug
  const source = await Deno.readTextFile(
    new URL("../routes-student.ts", import.meta.url).pathname,
  );

  for (const slug of EXPECTED_STUDENT_CRUD_SLUGS) {
    const pattern = `slug: "${slug}"`;
    assertEquals(
      source.includes(pattern),
      true,
      `CRUD slug "${slug}" not found in routes-student.ts — was it removed during a merge?`,
    );
  }
});

Deno.test("Route Integrity: schedule/index.ts mounts all expected sub-modules", async () => {
  const source = await Deno.readTextFile(
    new URL("../routes/schedule/index.ts", import.meta.url).pathname,
  );

  const expectedImports = [
    "momentumRoutes",
    "examPrepRoutes",
  ];

  for (const name of expectedImports) {
    assertEquals(
      source.includes(name),
      true,
      `Sub-module "${name}" not found in schedule/index.ts — was it removed during a merge?`,
    );
  }
});

Deno.test("Route Integrity: admin/index.ts mounts finals-periods", async () => {
  const source = await Deno.readTextFile(
    new URL("../routes/admin/index.ts", import.meta.url).pathname,
  );

  assertEquals(
    source.includes("finalsPeriodsRoutes"),
    true,
    "finalsPeriodsRoutes not found in admin/index.ts — was it removed during a merge?",
  );
});

Deno.test("Route Integrity: ai/index.ts mounts all expected sub-modules", async () => {
  const source = await Deno.readTextFile(
    new URL("../routes/ai/index.ts", import.meta.url).pathname,
  );

  const expectedImports = [
    "aiGenerateRoutes",
    "aiGenerateSmartRoutes",
    "aiReportRoutes",
    "aiReportDashboardRoutes",
    "aiPreGenerateRoutes",
    "aiIngestRoutes",
    "aiReChunkRoutes",
    "aiChatRoutes",
    "aiFeedbackRoutes",
    "aiAnalyticsRoutes",
    "aiIngestPdfRoutes",
    "aiRealtimeRoutes",
    "aiAnalyzeGraphRoutes",
    "aiSuggestConnectionsRoutes",
    "aiWeakPointsRoutes",
    "aiScheduleAgentRoutes",
    "aiWeeklyReportRoutes",
  ];

  for (const name of expectedImports) {
    assertEquals(
      source.includes(name),
      true,
      `Sub-module "${name}" not found in ai/index.ts — was it removed during a merge?`,
    );
  }
});

Deno.test("Route Integrity: content/index.ts mounts all critical sub-modules", async () => {
  const source = await Deno.readTextFile(
    new URL("../routes/content/index.ts", import.meta.url).pathname,
  );

  const expectedImports = [
    "contentCrudRoutes",
    "keywordSearchRoutes",
    "contentTreeRoutes",
    "flashcardsByTopicRoutes",
    "reorderRoutes",
    "publishSummaryRoutes",
    "blockMasteryRoutes",
  ];

  for (const name of expectedImports) {
    assertEquals(
      source.includes(name),
      true,
      `Sub-module "${name}" not found in content/index.ts — was it removed during a merge?`,
    );
  }
});

Deno.test("Route Integrity: gamification/index.ts mounts all sub-modules", async () => {
  const source = await Deno.readTextFile(
    new URL("../routes/gamification/index.ts", import.meta.url).pathname,
  );

  const expectedImports = [
    "profileRoutes",
    "badgeRoutes",
    "streakRoutes",
    "goalRoutes",
  ];

  for (const name of expectedImports) {
    assertEquals(
      source.includes(name),
      true,
      `Sub-module "${name}" not found in gamification/index.ts — was it removed during a merge?`,
    );
  }
});

Deno.test("Route Integrity: study/index.ts mounts all sub-modules", async () => {
  const source = await Deno.readTextFile(
    new URL("../routes/study/index.ts", import.meta.url).pathname,
  );

  const expectedImports = [
    "sessionRoutes",
    "reviewRoutes",
    "progressRoutes",
    "spacedRepRoutes",
    "batchReviewRoutes",
  ];

  for (const name of expectedImports) {
    assertEquals(
      source.includes(name),
      true,
      `Sub-module "${name}" not found in study/index.ts — was it removed during a merge?`,
    );
  }
});

Deno.test("Route Integrity: main index.ts mounts all 20 route groups", async () => {
  const source = await Deno.readTextFile(
    new URL("../index.ts", import.meta.url).pathname,
  );

  const expectedMounts = [
    "authRoutes",
    "memberRoutes",
    "content",
    "studentRoutes",
    "studyRoutes",
    "studyQueueRoutes",
    "modelRoutes",
    "planRoutes",
    "billingRoutes",
    "muxRoutes",
    "searchRoutes",
    "storageRoutes",
    "settingsRoutes",
    "aiRoutes",
    "whatsappRoutes",
    "telegramRoutes",
    "gamificationRoutes",
    "calendarRoutes",
    "scheduleRoutes",
    "adminRoutes",
  ];

  for (const name of expectedMounts) {
    const pattern = `app.route("/", ${name})`;
    assertEquals(
      source.includes(pattern),
      true,
      `Route mount "app.route("/", ${name})" not found in index.ts — was it removed during a merge?`,
    );
  }
});

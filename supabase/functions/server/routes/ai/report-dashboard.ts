/**
 * routes/ai/report-dashboard.ts — AI report dashboard endpoints (Fase 8C)
 *
 * GET /ai/report-stats   — Aggregate quality metrics via RPC
 * GET /ai/reports         — Paginated report listing with filters
 *
 * Purpose:
 *   Gives owners/admins/professors visibility into AI content quality.
 *   The stats endpoint provides a single-query overview (counts by status,
 *   reason, content_type + resolution performance). The listing endpoint
 *   lets moderators drill down into individual reports.
 *
 * Design decisions:
 *   D1: CONTENT_WRITE_ROLES — professors are part of the resolution
 *       workflow (PATCH in report.ts uses CONTENT_WRITE_ROLES). If they
 *       can resolve reports, they must be able to see them.
 *       Differs from analytics.ts which uses MANAGEMENT_ROLES because
 *       RAG analytics is infrastructure, reports are content quality.
 *   D2: GET endpoints bypass AI rate limit automatically — index.ts
 *       middleware only applies to POST requests.
 *   D3: Listing uses exact count, not estimated. ai_content_reports is
 *       a small table (<10k rows/institution). Dashboard needs accurate
 *       totals ("47 pending" not "~50 pending").
 *   D4: Order by created_at DESC (newest first). This is a moderator
 *       queue — they want to see the most recent reports first.
 *       Differs from crud-factory's created_at ASC / order_index ASC.
 *   D5: Filter validation uses isOneOf() with the same values as
 *       the DB CHECK constraints. Invalid filter values return 400,
 *       not silently ignored results.
 *   D6: institution_id is a query param (client-provided), not
 *       resolved from a parent entity. This is safe because
 *       requireInstitutionRole() verifies the caller's membership.
 *       Same pattern as analytics.ts.
 *
 * Pagination:
 *   Same constants as crud-factory.ts (max 500, default 100).
 *   Response shape: { items, total, limit, offset } — consistent.
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, PREFIX, getAdminClient } from "../../db.ts";
import { safeErr } from "../../lib/safe-error.ts";
import { isUuid, isOneOf } from "../../validate.ts";
import {
  requireInstitutionRole,
  isDenied,
  CONTENT_WRITE_ROLES,
} from "../../auth-helpers.ts";

export const aiReportDashboardRoutes = new Hono();

// ── Filter constants ─────────────────────────────────────────────
// Source of truth: CHECK constraints in 20260308_02_ai_content_reports.sql
// Defined locally (not imported from report.ts) to avoid coupling.
// If the DB schema changes, both files need updating — but the DB
// CHECK will reject invalid values regardless, so drift is caught.

const VALID_STATUSES = [
  "pending",
  "reviewed",
  "resolved",
  "dismissed",
] as const;

const VALID_REASONS = [
  "incorrect",
  "inappropriate",
  "low_quality",
  "irrelevant",
  "other",
] as const;

const VALID_CONTENT_TYPES = [
  "quiz_question",
  "flashcard",
] as const;

// ── Pagination (consistent with crud-factory.ts) ─────────────────
const MAX_PAGINATION_LIMIT = 500;
const DEFAULT_PAGINATION_LIMIT = 100;

function parsePagination(c: Context): { limit: number; offset: number } {
  let limit = parseInt(
    c.req.query("limit") ?? String(DEFAULT_PAGINATION_LIMIT),
    10,
  );
  let offset = parseInt(c.req.query("offset") ?? "0", 10);

  if (isNaN(limit) || limit < 1) limit = DEFAULT_PAGINATION_LIMIT;
  if (limit > MAX_PAGINATION_LIMIT) limit = MAX_PAGINATION_LIMIT;
  if (isNaN(offset) || offset < 0) offset = 0;

  return { limit, offset };
}

// ================================================================
// GET /ai/report-stats — Aggregate AI content quality metrics
//
// Query params:
//   institution_id (required) — UUID
//   from (optional)           — ISO 8601 start date
//   to (optional)             — ISO 8601 end date
//
// Returns 14 flat columns from get_ai_report_stats() RPC.
// Defaults: from = now()-30d, to = now() (handled by RPC defaults).
// ================================================================

aiReportDashboardRoutes.get(
  `${PREFIX}/ai/report-stats`,
  async (c: Context) => {
    // ── Step 1: Auth (PF-05: JWT before any operation) ────────
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    // ── Step 2: Validate institution_id ──────────────────────
    const institutionId = c.req.query("institution_id");
    if (!isUuid(institutionId))
      return err(
        c,
        "institution_id query param is required (valid UUID)",
        400,
      );

    // ── Step 3: Verify role (D1: CONTENT_WRITE_ROLES) ────────
    const roleCheck = await requireInstitutionRole(
      db,
      user.id,
      institutionId!,
      CONTENT_WRITE_ROLES,
    );
    if (isDenied(roleCheck))
      return err(c, roleCheck.message, roleCheck.status);

    // ── Step 4: Parse optional date range ─────────────────────
    const from = c.req.query("from") || undefined;
    const to = c.req.query("to") || undefined;

    if (from && isNaN(Date.parse(from)))
      return err(c, "'from' must be a valid ISO 8601 date", 400);
    if (to && isNaN(Date.parse(to)))
      return err(c, "'to' must be a valid ISO 8601 date", 400);

    // ── Step 5: Call RPC ──────────────────────────────────────
    // RPC defaults: p_from = now()-30d, p_to = now()
    // Only pass if user explicitly provided values.
    const rpcParams: Record<string, unknown> = {
      p_institution_id: institutionId,
    };
    if (from) rpcParams.p_from = from;
    if (to) rpcParams.p_to = to;

    // SEC-S9B: Use admin client for SECURITY DEFINER RPCs
    const { data, error } = await getAdminClient().rpc(
      "get_ai_report_stats",
      rpcParams,
    );

    if (error)
      return safeErr(c, "Report stats query", error);

    // ── Step 6: Extract + fallback ───────────────────────────
    // RPC returns TABLE → Supabase client wraps in array.
    // Aggregate always returns exactly 1 row, but fallback
    // protects against edge cases (RPC error, null response).
    const result = Array.isArray(data) ? data[0] : data;

    return ok(
      c,
      result || {
        total_reports: 0,
        pending_count: 0,
        reviewed_count: 0,
        resolved_count: 0,
        dismissed_count: 0,
        reason_incorrect: 0,
        reason_inappropriate: 0,
        reason_low_quality: 0,
        reason_irrelevant: 0,
        reason_other: 0,
        type_quiz_question: 0,
        type_flashcard: 0,
        avg_resolution_hours: 0,
        resolution_rate: 0,
      },
    );
  },
);

// ================================================================
// GET /ai/reports — Paginated listing of AI content reports
//
// Query params:
//   institution_id (required)  — UUID
//   status (optional)          — filter by report status
//   reason (optional)          — filter by report reason
//   content_type (optional)    — filter by content type
//   limit (optional)           — pagination limit (default 100, max 500)
//   offset (optional)          — pagination offset (default 0)
//
// Returns: { items: Report[], total: number, limit: number, offset: number }
// Order: created_at DESC (newest first — moderator queue pattern)
// ================================================================

aiReportDashboardRoutes.get(
  `${PREFIX}/ai/reports`,
  async (c: Context) => {
    // ── Step 1: Auth ─────────────────────────────────────────
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    // ── Step 2: Validate institution_id ──────────────────────
    const institutionId = c.req.query("institution_id");
    if (!isUuid(institutionId))
      return err(
        c,
        "institution_id query param is required (valid UUID)",
        400,
      );

    // ── Step 3: Verify role (D1: CONTENT_WRITE_ROLES) ────────
    const roleCheck = await requireInstitutionRole(
      db,
      user.id,
      institutionId!,
      CONTENT_WRITE_ROLES,
    );
    if (isDenied(roleCheck))
      return err(c, roleCheck.message, roleCheck.status);

    // ── Step 4: Validate optional filters (D5) ───────────────
    // Invalid filter values return 400, not silently empty results.
    // This prevents typos like "pendign" from returning 0 reports
    // when the user meant "pending" and expects results.
    const statusFilter = c.req.query("status");
    if (statusFilter && !isOneOf(statusFilter, VALID_STATUSES))
      return err(
        c,
        `Invalid status filter. Must be one of: ${VALID_STATUSES.join(", ")}`,
        400,
      );

    const reasonFilter = c.req.query("reason");
    if (reasonFilter && !isOneOf(reasonFilter, VALID_REASONS))
      return err(
        c,
        `Invalid reason filter. Must be one of: ${VALID_REASONS.join(", ")}`,
        400,
      );

    const contentTypeFilter = c.req.query("content_type");
    if (contentTypeFilter && !isOneOf(contentTypeFilter, VALID_CONTENT_TYPES))
      return err(
        c,
        `Invalid content_type filter. Must be one of: ${VALID_CONTENT_TYPES.join(", ")}`,
        400,
      );

    // ── Step 5: Build query ──────────────────────────────────
    // D3: Exact count — small table, dashboard needs accurate totals.
    let query = db
      .from("ai_content_reports")
      .select("*", { count: "exact" })
      .eq("institution_id", institutionId!);

    // Apply optional filters (only if provided and already validated)
    if (statusFilter) query = query.eq("status", statusFilter);
    if (reasonFilter) query = query.eq("reason", reasonFilter);
    if (contentTypeFilter) query = query.eq("content_type", contentTypeFilter);

    // D4: Order by created_at DESC (moderator queue — newest first)
    query = query.order("created_at", { ascending: false });

    // Pagination (same pattern as crud-factory.ts)
    const { limit, offset } = parsePagination(c);
    query = query.range(offset, offset + limit - 1);

    // ── Step 6: Execute ──────────────────────────────────────
    const { data, count, error } = await query;

    if (error)
      return safeErr(c, "Report listing", error);

    // ── Step 7: Return consistent shape ──────────────────────
    // Same response shape as crud-factory LIST endpoints.
    return ok(c, { items: data, total: count, limit, offset });
  },
);

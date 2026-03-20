/**
 * routes/ai/report.ts — AI content report endpoints (Fase 8B)
 *
 * POST  /ai/report      — Create a report on AI-generated content
 * PATCH /ai/report/:id   — Resolve/update a report (owner/admin/professor)
 *
 * Purpose:
 *   Closes the feedback loop of the adaptive AI system.
 *   Students and professors can flag AI-generated quiz questions or
 *   flashcards as incorrect, inappropriate, low quality, or irrelevant.
 *   Owners/admins/professors can then review and resolve reports.
 *
 * Design decisions:
 *   D1: Polymorphic FK (content_type + content_id) — one table for both types
 *   D2: institution_id resolved server-side from content's summary_id
 *   D3: POST — ANY active member can report (ALL_ROLES)
 *   D4: PATCH — Only owner/admin/professor (CONTENT_WRITE_ROLES)
 *   D5: UNIQUE(content_type, content_id, reported_by) — one report per user per content
 *
 * Audit fixes incorporated:
 *   P1: Only AI-generated content can be reported (.eq('source', 'ai'))
 *   P5: description max 2000 chars (DB CHECK + app validation)
 *   P6: Excluded from AI rate limit (no Gemini cost) — handled in index.ts
 *   P7: resolved_at/resolved_by conditional logic per target status
 *   A1-TS: RESOLVER_ROLES replaced with CONTENT_WRITE_ROLES (audit fix)
 *   A2-TS: Removed `as unknown as string[]` cast (resolved by A1-TS)
 *   A3-TS: Over-select fixed — .select("summary_id") only
 *
 * Reviewer feedback incorporated:
 *   Point 1: .maybeSingle() for existence checks (cleaner than .single())
 *   Point 2: resolved_by semantics documented inline
 *   Point 6: String normalization with .trim() || null
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, safeJson, PREFIX } from "../../db.ts";
import { safeErr } from "../../lib/safe-error.ts";
import { isUuid, isOneOf } from "../../validate.ts";
import {
  requireInstitutionRole,
  isDenied,
  ALL_ROLES,
  CONTENT_WRITE_ROLES,
} from "../../auth-helpers.ts";

export const aiReportRoutes = new Hono();

// ── Typed constants (EC2: no hardcoded strings inline) ────────
const CONTENT_TYPES = ["quiz_question", "flashcard"] as const;
const REASONS = [
  "incorrect",
  "inappropriate",
  "low_quality",
  "irrelevant",
  "other",
] as const;
const PATCH_STATUSES = [
  "pending",
  "reviewed",
  "resolved",
  "dismissed",
] as const;

// D4: Roles that can resolve/review reports.
// Reuses CONTENT_WRITE_ROLES from auth-helpers.ts: ["owner", "admin", "professor"]
// Students can report (ALL_ROLES) but cannot resolve.
//
// A1-TS audit fix: Previously used ["admin", "teacher", "coordinator"]
// which contained non-existent role names ("teacher" should be "professor",
// "coordinator" doesn't exist) and omitted "owner". This caused PATCH
// to be inaccessible for professors and owners.

const MAX_DESCRIPTION_LENGTH = 2000; // P5: matches DB CHECK constraint

// ── Helper: map content_type to DB table name ─────────────────
function contentTable(type: string): string {
  return type === "quiz_question" ? "quiz_questions" : "flashcards";
}

// ================================================================
// POST /ai/report — Create a report on AI-generated content
// ================================================================
aiReportRoutes.post(`${PREFIX}/ai/report`, async (c: Context) => {
  // ── Step 1: Auth (PF-05: JWT before any operation) ──────────
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  // ── Step 2: Validate body ──────────────────────────────────
  const body = await safeJson(c);
  if (!body) return err(c, "Invalid JSON body", 400);

  const contentType = body.content_type as string;
  if (!isOneOf(contentType, CONTENT_TYPES))
    return err(c, "content_type must be 'quiz_question' or 'flashcard'", 400);

  if (!isUuid(body.content_id))
    return err(c, "content_id is required (UUID)", 400);
  const contentId = body.content_id as string;

  const reason = body.reason as string;
  if (!isOneOf(reason, REASONS))
    return err(
      c,
      "reason must be one of: incorrect, inappropriate, low_quality, irrelevant, other",
      400,
    );

  // Point 6: normalize strings — trim + collapse empty to null
  const description =
    typeof body.description === "string"
      ? body.description.trim() || null
      : null;

  // P5: app-level length check (friendlier than DB error)
  if (description && description.length > MAX_DESCRIPTION_LENGTH)
    return err(
      c,
      `description must be ${MAX_DESCRIPTION_LENGTH} characters or less`,
      400,
    );

  // ── Step 3: Fetch content + validate source='ai' (P1, E2, E8) ─
  // Point 1: .maybeSingle() — returns null on 0 rows, not an error
  // A3-TS: select only summary_id (source is filtered, not read)
  const table = contentTable(contentType);
  const { data: content, error: contentErr } = await db
    .from(table)
    .select("summary_id")
    .eq("id", contentId)
    .eq("source", "ai") // P1: only AI-generated content can be reported
    .maybeSingle();

  if (contentErr) {
    console.error("[Report] Content fetch error:", contentErr.message);
    return err(c, "Failed to validate content", 500);
  }

  if (!content) {
    // E2 + P1: content doesn't exist OR exists but source != 'ai'
    return err(
      c,
      "Content not found or not AI-generated. " +
        "Only AI-generated content can be reported through this endpoint.",
      404,
    );
  }

  // ── Step 4: Resolve institution_id server-side (D2, E3) ────
  const { data: institutionId } = await db.rpc(
    "resolve_parent_institution",
    { p_table: "summaries", p_id: content.summary_id },
  );
  if (!institutionId)
    return err(c, "Summary not found or inaccessible", 404);

  // ── Step 5: Verify role in institution (D3: ALL_ROLES) ─────
  const roleCheck = await requireInstitutionRole(
    db,
    user.id,
    institutionId as string,
    ALL_ROLES,
  );
  if (isDenied(roleCheck))
    return err(c, roleCheck.message, roleCheck.status);

  // ── Step 6: INSERT report ──────────────────────────────────
  const { data: report, error: insertErr } = await db
    .from("ai_content_reports")
    .insert({
      content_type: contentType,
      content_id: contentId,
      reported_by: user.id,
      institution_id: institutionId as string,
      reason,
      description,
      // status defaults to 'pending' via DB DEFAULT
    })
    .select()
    .single();

  if (insertErr) {
    // E1: unique_violation — user already reported this content
    if (insertErr.code === "23505") {
      return err(c, "You have already reported this content", 409);
    }
    console.error("[Report] Insert error:", insertErr.message);
    return safeErr(c, "Create report", insertErr);
  }

  // ── Step 7: Return created report ──────────────────────────
  return ok(c, report, 201);
});

// ================================================================
// PATCH /ai/report/:id — Resolve/update a report
// ================================================================
aiReportRoutes.patch(`${PREFIX}/ai/report/:id`, async (c: Context) => {
  // ── Step 1: Auth (PF-05) ───────────────────────────────────
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  // ── Step 2: Validate params + body ─────────────────────────
  const reportId = c.req.param("id");
  if (!isUuid(reportId))
    return err(c, "Report id must be a valid UUID", 400);

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid JSON body", 400);

  const status = body.status as string;
  if (!isOneOf(status, PATCH_STATUSES))
    return err(
      c,
      "status must be one of: pending, reviewed, resolved, dismissed",
      400,
    );

  // Point 6: normalize strings
  const resolutionNote =
    typeof body.resolution_note === "string"
      ? body.resolution_note.trim() || null
      : null;

  // ── Step 3: Fetch existing report (E4) ─────────────────────
  // Point 1: .maybeSingle() — clean null on not-found
  const { data: report, error: fetchErr } = await db
    .from("ai_content_reports")
    .select("*")
    .eq("id", reportId)
    .maybeSingle();

  if (fetchErr) {
    console.error("[Report] Fetch error:", fetchErr.message);
    return err(c, "Failed to fetch report", 500);
  }
  if (!report) return err(c, "Report not found", 404);

  // ── Step 4: Verify role in report's institution (D4, E5, E7) ─
  // E7: use report.institution_id, NOT a client-provided value (EC6)
  // A1-TS audit fix: Uses CONTENT_WRITE_ROLES ["owner", "admin", "professor"]
  // from auth-helpers.ts instead of the incorrect local RESOLVER_ROLES.
  const roleCheck = await requireInstitutionRole(
    db,
    user.id,
    report.institution_id as string,
    CONTENT_WRITE_ROLES,
  );
  if (isDenied(roleCheck))
    return err(c, "Insufficient permissions to manage reports", 403);

  // ── Step 5: Build update payload with conditional logic (P7) ─
  //
  // Point 2: resolved_by semantics:
  //   - "resolved_by" means "last moderator who acted", not strictly
  //     "who resolved". Set on reviewed/resolved/dismissed.
  //   - NULLed on re-open to pending (clean reset — E10).
  //
  // P7: resolved_at only set for terminal states (resolved/dismissed).
  //     'reviewed' is non-terminal — admin looked but hasn't decided.

  type UpdatePayload = {
    status: string;
    resolved_by: string | null;
    resolved_at: string | null;
    resolution_note: string | null;
  };

  let payload: UpdatePayload;

  if (status === "pending") {
    // Re-open: full reset (E10)
    payload = {
      status: "pending",
      resolved_by: null,
      resolved_at: null,
      resolution_note: null,
    };
  } else if (status === "reviewed") {
    // Non-terminal: moderator looked at it, no final decision yet
    payload = {
      status: "reviewed",
      resolved_by: user.id,
      resolved_at: null, // NOT resolved yet
      resolution_note: resolutionNote,
    };
  } else {
    // Terminal: 'resolved' or 'dismissed'
    payload = {
      status,
      resolved_by: user.id,
      resolved_at: new Date().toISOString(),
      resolution_note: resolutionNote,
    };
  }

  // ── Step 6: UPDATE report ──────────────────────────────────
  const { data: updated, error: updateErr } = await db
    .from("ai_content_reports")
    .update(payload)
    .eq("id", reportId)
    .select()
    .single();

  if (updateErr) {
    console.error("[Report] Update error:", updateErr.message);
    return safeErr(c, "Update report", updateErr);
  }

  // ── Step 7: Return updated report ──────────────────────────
  return ok(c, updated, 200);
});

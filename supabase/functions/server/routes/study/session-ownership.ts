/**
 * routes/study/session-ownership.ts — Shared study_sessions ownership check
 *
 * Extracted from reviews.ts and batch-review.ts (previously duplicated with
 * slightly divergent signatures). Callers map the structured result to a
 * Response in their own idiom (safeErr vs err).
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js";

export type SessionOwnershipResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "lookup_failed"; message: string };

export async function verifySessionOwnership(
  db: SupabaseClient,
  sessionId: string,
  userId: string,
): Promise<SessionOwnershipResult> {
  const { data: session, error: sessionErr } = await db
    .from("study_sessions")
    .select("id")
    .eq("id", sessionId)
    .eq("student_id", userId)
    .maybeSingle();

  if (sessionErr) {
    return {
      ok: false,
      reason: "lookup_failed",
      message: `Session lookup failed: ${sessionErr.message}`,
    };
  }
  if (!session) {
    return {
      ok: false,
      reason: "not_found",
      message: "Session not found or does not belong to you",
    };
  }
  return { ok: true };
}

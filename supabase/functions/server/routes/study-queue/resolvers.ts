/**
 * routes/study-queue/resolvers.ts — Summary ID resolution for study queue
 *
 * Extracted from routes-study-queue.ts (PR #103).
 * Resolves which summary IDs a student can study, by course or globally.
 *
 * Exports:
 *   resolveSummaryIdsForCourse  — Via RPC or hierarchy traversal
 *   resolveSummaryIdsForStudent — Via memberships → courses → summaries
 */

import { getAdminClient } from "../../db.ts";

// ─── Course → Summary IDs resolution ───────────────────────────

export async function resolveSummaryIdsForCourse(
  courseId: string,
): Promise<Set<string> | null> {
  const db = getAdminClient();
  // SEC-S9B: Use admin client for SECURITY DEFINER RPCs
  const { data: rpcData, error: rpcError } = await db.rpc(
    "get_course_summary_ids",
    { p_course_id: courseId },
  );

  if (!rpcError && rpcData) {
    if (rpcData.length === 0) return null;
    return new Set(rpcData.map((r: { id: string }) => r.id));
  }

  console.warn(`[study-queue] RPC failed, using fallback: ${rpcError?.message}`);

  const { data: semesters } = await db.from("semesters").select("id").eq("course_id", courseId).is("deleted_at", null);
  if (!semesters || semesters.length === 0) return null;
  const semesterIds = semesters.map((s: { id: string }) => s.id);

  const { data: sections } = await db.from("sections").select("id").in("semester_id", semesterIds).is("deleted_at", null);
  if (!sections || sections.length === 0) return null;
  const sectionIds = sections.map((s: { id: string }) => s.id);

  const { data: topics } = await db.from("topics").select("id").in("section_id", sectionIds).is("deleted_at", null);
  if (!topics || topics.length === 0) return null;
  const topicIds = topics.map((t: { id: string }) => t.id);

  const { data: summaries } = await db.from("summaries").select("id").in("topic_id", topicIds).is("deleted_at", null);
  if (!summaries || summaries.length === 0) return null;
  return new Set(summaries.map((s: { id: string }) => s.id));
}

// ─── Student → Summary IDs resolution ──────────────────────────

export async function resolveSummaryIdsForStudent(
  userId: string,
): Promise<Set<string> | null> {
  const db = getAdminClient();
  // Step 1: Get user's institution memberships (needed for both RPC and fallback)
  const { data: memberships } = await db
    .from("memberships")
    .select("institution_id")
    .eq("user_id", userId)
    .eq("is_active", true);
  if (!memberships || memberships.length === 0) return null;

  // Step 2: Try RPC per institution — single query replaces 6-query waterfall
  const allIds = new Set<string>();
  let rpcFailed = false;

  for (const m of memberships) {
    const { data: rpcData, error: rpcError } = await db.rpc(
      "resolve_student_summary_ids",
      { p_student_id: userId, p_institution_id: m.institution_id },
    );

    if (rpcError) {
      console.warn(`[study-queue] resolve_student_summary_ids RPC failed, using fallback: ${rpcError.message}`);
      rpcFailed = true;
      break;
    }

    if (rpcData) {
      for (const r of rpcData as { summary_id: string }[]) {
        allIds.add(r.summary_id);
      }
    }
  }

  if (!rpcFailed) {
    return allIds.size > 0 ? allIds : null;
  }

  // ── Fallback: 6-query waterfall ──────────────────────────────
  const institutionIds = memberships.map((m: { institution_id: string }) => m.institution_id);

  const { data: courses } = await db.from("courses").select("id").in("institution_id", institutionIds).eq("is_active", true);
  if (!courses || courses.length === 0) return null;
  const courseIds = courses.map((c: { id: string }) => c.id);

  const { data: semesters } = await db.from("semesters").select("id").in("course_id", courseIds).is("deleted_at", null);
  if (!semesters || semesters.length === 0) return null;
  const semesterIds = semesters.map((s: { id: string }) => s.id);

  const { data: sections } = await db.from("sections").select("id").in("semester_id", semesterIds).is("deleted_at", null);
  if (!sections || sections.length === 0) return null;
  const sectionIds = sections.map((s: { id: string }) => s.id);

  const { data: topics } = await db.from("topics").select("id").in("section_id", sectionIds).is("deleted_at", null);
  if (!topics || topics.length === 0) return null;
  const topicIds = topics.map((t: { id: string }) => t.id);

  const { data: summaries } = await db.from("summaries").select("id").in("topic_id", topicIds).is("deleted_at", null);
  if (!summaries || summaries.length === 0) return null;
  return new Set(summaries.map((s: { id: string }) => s.id));
}

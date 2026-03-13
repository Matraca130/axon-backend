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

import type { SupabaseClient } from "npm:@supabase/supabase-js";

// ─── Course → Summary IDs resolution ───────────────────────────

export async function resolveSummaryIdsForCourse(
  db: SupabaseClient,
  courseId: string,
): Promise<Set<string> | null> {
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
  db: SupabaseClient,
  userId: string,
): Promise<Set<string> | null> {
  const { data: memberships } = await db.from("memberships").select("institution_id").eq("user_id", userId).eq("is_active", true);
  if (!memberships || memberships.length === 0) return null;
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

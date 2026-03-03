/**
 * routes/search/helpers.ts — Search shared utilities
 *
 * N-8 FIX: escapeLike() sanitizes SQL wildcards in user input.
 * P-3 FIX: escapeOrQuote() escapes double quotes for PostgREST or().
 * P-1 FIX: batchResolvePaths() resolves full hierarchy paths.
 */

// ─── Escape helpers ────────────────────────────────────────────────────

export function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}

export function escapeOrQuote(s: string): string {
  return s.replace(/"/g, '""');
}

// ─── Types ───────────────────────────────────────────────────────────

interface TopicPath {
  id: string; name: string;
  sections: { name: string; semesters: { name: string; courses: { name: string } } } | null;
}

interface SummaryPath {
  id: string; title: string;
  topics: { name: string; sections: { name: string; semesters: { name: string; courses: { name: string } } } | null } | null;
}

// ─── Batch path resolution ─────────────────────────────────────────────

export async function batchResolvePaths(
  db: any,
  topicIds: string[],
  summaryIds: string[],
): Promise<{ topicPathMap: Map<string, string>; summaryPathMap: Map<string, string> }> {
  const topicPathMap = new Map<string, string>();
  const summaryPathMap = new Map<string, string>();
  const promises: Promise<void>[] = [];

  if (topicIds.length > 0) {
    const unique = [...new Set(topicIds)];
    promises.push((async () => {
      const { data: topics } = await db
        .from("topics").select("id, name, sections(name, semesters(name, courses(name)))")
        .in("id", unique);
      for (const t of (topics as TopicPath[]) ?? []) {
        const sec = t.sections;
        if (!sec) { topicPathMap.set(t.id, t.name); continue; }
        const sem = sec.semesters;
        if (!sem) { topicPathMap.set(t.id, t.name); continue; }
        const course = sem.courses;
        if (!course) { topicPathMap.set(t.id, `${sem.name} > ${t.name}`); continue; }
        topicPathMap.set(t.id, `${course.name} > ${sem.name} > ${t.name}`);
      }
    })());
  }

  if (summaryIds.length > 0) {
    const unique = [...new Set(summaryIds)];
    promises.push((async () => {
      const { data: summaries } = await db
        .from("summaries").select("id, title, topics(name, sections(name, semesters(name, courses(name))))")
        .in("id", unique);
      for (const s of (summaries as SummaryPath[]) ?? []) {
        const topic = s.topics;
        if (!topic) { summaryPathMap.set(s.id, s.title); continue; }
        const sec = topic.sections;
        if (!sec) { summaryPathMap.set(s.id, `${topic.name} > ${s.title}`); continue; }
        const sem = sec.semesters;
        if (!sem) { summaryPathMap.set(s.id, `${topic.name} > ${s.title}`); continue; }
        const course = sem.courses;
        if (!course) { summaryPathMap.set(s.id, `${sem.name} > ${topic.name} > ${s.title}`); continue; }
        summaryPathMap.set(s.id, `${course.name} > ${sem.name} > ${topic.name} > ${s.title}`);
      }
    })());
  }

  await Promise.all(promises);
  return { topicPathMap, summaryPathMap };
}

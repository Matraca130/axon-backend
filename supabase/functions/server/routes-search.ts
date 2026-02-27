// ============================================================
// routes-search.ts — Global Search, Trash & Restore
//
// GET  ${PREFIX}/search?q=texto&type=all|summaries|videos|keywords
// GET  ${PREFIX}/trash?type=summaries|keywords|flashcards|quiz-questions|videos
// POST ${PREFIX}/restore/:table/:id
//
// N-1 FIX: Search queries + path resolution run in parallel.
// N-2 FIX: Trash queries run in parallel via Promise.all.
// N-8 FIX: escapeLike() sanitizes SQL wildcards in user input.
// O-1 FIX: or() filter values quoted to prevent comma/paren injection.
// P-1 FIX: summaryPathMap resolves full Course>Semester>Topic>Summary.
// P-3 FIX: Double quotes escaped in or() pattern interpolation.
// ============================================================

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, PREFIX } from "./db.ts";

export const searchRoutes = new Hono();

// ── Whitelist de tabelas permitidas para restore ─────────────
const RESTORE_WHITELIST: Record<string, string> = {
  summaries: "summaries",
  keywords: "keywords",
  flashcards: "flashcards",
  "quiz-questions": "quiz_questions",
  videos: "videos",
};

// ── Roles que podem restaurar ────────────────────────────────
const RESTORE_ROLES = ["owner", "admin", "professor"];

// ── N-8 FIX: Escape SQL LIKE wildcards ───────────────────────
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}

// ── P-3 FIX: Escape double quotes for PostgREST or() quoting ─
// PostgREST uses "..." to quote values in or() filters.
// Literal double quotes inside must be doubled: " → ""
function escapeOrQuote(s: string): string {
  return s.replace(/"/g, '""');
}

// ── Types for path resolution ────────────────────────────────
interface TopicPath {
  id: string;
  name: string;
  sections: {
    name: string;
    semesters: {
      name: string;
      courses: {
        name: string;
      };
    };
  } | null;
}

// P-1 FIX: Full hierarchy for summary paths
interface SummaryPath {
  id: string;
  title: string;
  topics: {
    name: string;
    sections: {
      name: string;
      semesters: {
        name: string;
        courses: {
          name: string;
        };
      };
    } | null;
  } | null;
}

// ── Batch path resolution (replaces N+1 buildParentPath) ─────
async function batchResolvePaths(
  db: any,
  topicIds: string[],
  summaryIds: string[],
): Promise<{
  topicPathMap: Map<string, string>;
  summaryPathMap: Map<string, string>;
}> {
  const topicPathMap = new Map<string, string>();
  const summaryPathMap = new Map<string, string>();

  const promises: Promise<void>[] = [];

  if (topicIds.length > 0) {
    const uniqueTopicIds = [...new Set(topicIds)];
    promises.push(
      (async () => {
        const { data: topics } = await db
          .from("topics")
          .select(
            "id, name, sections(name, semesters(name, courses(name)))",
          )
          .in("id", uniqueTopicIds);

        for (const t of (topics as TopicPath[]) ?? []) {
          const sec = t.sections;
          if (!sec) {
            topicPathMap.set(t.id, t.name);
            continue;
          }
          const sem = sec.semesters;
          if (!sem) {
            topicPathMap.set(t.id, t.name);
            continue;
          }
          const course = sem.courses;
          if (!course) {
            topicPathMap.set(t.id, `${sem.name} > ${t.name}`);
            continue;
          }
          topicPathMap.set(
            t.id,
            `${course.name} > ${sem.name} > ${t.name}`,
          );
        }
      })(),
    );
  }

  if (summaryIds.length > 0) {
    const uniqueSummaryIds = [...new Set(summaryIds)];
    promises.push(
      (async () => {
        // P-1 FIX: Full hierarchy select — was only "topics(name)"
        const { data: summaries } = await db
          .from("summaries")
          .select(
            "id, title, topics(name, sections(name, semesters(name, courses(name))))",
          )
          .in("id", uniqueSummaryIds);

        for (const s of (summaries as SummaryPath[]) ?? []) {
          const topic = s.topics;
          if (!topic) {
            summaryPathMap.set(s.id, s.title);
            continue;
          }
          const sec = topic.sections;
          if (!sec) {
            summaryPathMap.set(s.id, `${topic.name} > ${s.title}`);
            continue;
          }
          const sem = sec.semesters;
          if (!sem) {
            summaryPathMap.set(s.id, `${topic.name} > ${s.title}`);
            continue;
          }
          const course = sem.courses;
          if (!course) {
            summaryPathMap.set(
              s.id,
              `${sem.name} > ${topic.name} > ${s.title}`,
            );
            continue;
          }
          summaryPathMap.set(
            s.id,
            `${course.name} > ${sem.name} > ${topic.name} > ${s.title}`,
          );
        }
      })(),
    );
  }

  await Promise.all(promises);
  return { topicPathMap, summaryPathMap };
}

// ── GET ${PREFIX}/search ─────────────────────────────────────
searchRoutes.get(`${PREFIX}/search`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const q = c.req.query("q")?.trim();
  const type = c.req.query("type") || "all";

  if (!q || q.length < 2) {
    return err(c, "Query 'q' must be at least 2 characters", 400);
  }

  const pattern = `%${escapeLike(q)}%`;
  // P-3 FIX: Escape double quotes for PostgREST or() quoting context
  const orPattern = escapeOrQuote(pattern);

  try {
    // ── N-1 FIX: Fire all search queries in parallel ─────────
    const [summariesResult, keywordsResult, videosResult] = await Promise.all([
      type === "all" || type === "summaries"
        ? db
            .from("summaries")
            .select("id, title, content_markdown, topic_id")
            .is("deleted_at", null)
            .or(`title.ilike."${orPattern}",content_markdown.ilike."${orPattern}"`)
            .limit(type === "all" ? 7 : 20)
        : Promise.resolve({ data: [] }),

      type === "all" || type === "keywords"
        ? db
            .from("keywords")
            .select("id, name, definition, summary_id")
            .is("deleted_at", null)
            .or(`name.ilike."${orPattern}",definition.ilike."${orPattern}"`)
            .limit(type === "all" ? 7 : 20)
        : Promise.resolve({ data: [] }),

      type === "all" || type === "videos"
        ? db
            .from("videos")
            .select("id, title, summary_id")
            .is("deleted_at", null)
            .ilike("title", pattern)
            .limit(type === "all" ? 6 : 20)
        : Promise.resolve({ data: [] }),
    ]);

    const summaries = summariesResult.data ?? [];
    const keywords = keywordsResult.data ?? [];
    const videos = videosResult.data ?? [];

    // ── Batch path resolution ────────────────────────────────
    const topicIds: string[] = [];
    const summaryIdsForPaths: string[] = [];

    for (const s of summaries) {
      if (s.topic_id) topicIds.push(s.topic_id);
    }
    for (const k of keywords) {
      if (k.summary_id) summaryIdsForPaths.push(k.summary_id);
    }
    for (const v of videos) {
      if (v.summary_id) summaryIdsForPaths.push(v.summary_id);
    }

    const { topicPathMap, summaryPathMap } = await batchResolvePaths(
      db,
      topicIds,
      summaryIdsForPaths,
    );

    // ── Build results ────────────────────────────────────────
    const results: {
      type: string;
      id: string;
      title: string;
      snippet: string;
      parent_path: string;
      _score: number;
    }[] = [];

    const qLower = q.toLowerCase();

    for (const s of summaries) {
      const inTitle = s.title?.toLowerCase().includes(qLower);
      const snippet = inTitle
        ? s.title
        : (s.content_markdown || "").substring(0, 120).replace(/\n/g, " ") +
          "...";
      results.push({
        type: "summary",
        id: s.id,
        title: s.title,
        snippet,
        parent_path: s.topic_id ? (topicPathMap.get(s.topic_id) ?? "") : "",
        _score: inTitle ? 2 : 1,
      });
    }

    for (const k of keywords) {
      const inName = k.name?.toLowerCase().includes(qLower);
      const snippet = inName
        ? k.definition?.substring(0, 120) || k.name
        : (k.definition || "").substring(0, 120) + "...";
      results.push({
        type: "keyword",
        id: k.id,
        title: k.name,
        snippet,
        parent_path: k.summary_id
          ? (summaryPathMap.get(k.summary_id) ?? "")
          : "",
        _score: inName ? 2 : 1,
      });
    }

    for (const v of videos) {
      results.push({
        type: "video",
        id: v.id,
        title: v.title,
        snippet: v.title,
        parent_path: v.summary_id
          ? (summaryPathMap.get(v.summary_id) ?? "")
          : "",
        _score: 2,
      });
    }

    results.sort((a, b) => b._score - a._score);

    const final = results
      .slice(0, 20)
      .map(({ _score, ...r }) => r);

    return ok(c, { results: final });
  } catch (e: any) {
    return err(c, `Search error: ${e.message}`, 500);
  }
});

// ── GET ${PREFIX}/trash ──────────────────────────────────────
searchRoutes.get(`${PREFIX}/trash`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const type = c.req.query("type");

  const TABLE_MAP: Record<string, { table: string; titleField: string }> = {
    summaries: { table: "summaries", titleField: "title" },
    keywords: { table: "keywords", titleField: "name" },
    flashcards: { table: "flashcards", titleField: "front" },
    "quiz-questions": { table: "quiz_questions", titleField: "question_text" },
    videos: { table: "videos", titleField: "title" },
  };

  const targets =
    type && TABLE_MAP[type]
      ? [{ key: type, ...TABLE_MAP[type] }]
      : Object.entries(TABLE_MAP).map(([key, v]) => ({ key, ...v }));

  try {
    const queryResults = await Promise.all(
      targets.map((target) =>
        db
          .from(target.table)
          .select(`id, ${target.titleField}, deleted_at`)
          .not("deleted_at", "is", null)
          .order("deleted_at", { ascending: false })
          .limit(50),
      ),
    );

    const items: {
      id: string;
      type: string;
      title: string;
      deleted_at: string;
    }[] = [];

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      for (const item of queryResults[i].data || []) {
        items.push({
          id: item.id,
          type: target.key,
          title: item[target.titleField] || item.id,
          deleted_at: item.deleted_at,
        });
      }
    }

    items.sort(
      (a, b) =>
        new Date(b.deleted_at).getTime() - new Date(a.deleted_at).getTime(),
    );

    return ok(c, { items: items.slice(0, 50) });
  } catch (e: any) {
    return err(c, `Trash error: ${e.message}`, 500);
  }
});

// ── POST ${PREFIX}/restore/:table/:id ────────────────────────
searchRoutes.post(`${PREFIX}/restore/:table/:id`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const tableParam = c.req.param("table");
  const id = c.req.param("id");

  const realTable = RESTORE_WHITELIST[tableParam];
  if (!realTable) {
    return err(
      c,
      `Table '${tableParam}' not allowed. Allowed: ${Object.keys(RESTORE_WHITELIST).join(", ")}`,
      400,
    );
  }

  const { data: membership } = await db
    .from("memberships")
    .select("role")
    .eq("user_id", user.id)
    .single();

  if (!membership || !RESTORE_ROLES.includes(membership.role)) {
    return err(c, "Insufficient permissions to restore items", 403);
  }

  try {
    const { data, error } = await db
      .from(realTable)
      .update({ deleted_at: null })
      .eq("id", id)
      .not("deleted_at", "is", null)
      .select()
      .single();

    if (error) return err(c, error.message, 400);
    if (!data) return err(c, "Item not found or already active", 404);

    return ok(c, { restored: true, item: data });
  } catch (e: any) {
    return err(c, `Restore error: ${e.message}`, 500);
  }
});

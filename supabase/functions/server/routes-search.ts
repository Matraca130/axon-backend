// ============================================================
// routes-search.ts — Busca global, Lixeira e Restauração
//
// GET  /search?q=texto&type=all|summaries|videos|keywords
// GET  /trash?type=summaries|keywords|flashcards|quiz-questions|videos
// POST /restore/:table/:id
// ============================================================

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err } from "./db.ts";

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

// ── Helper: construir parent_path via JOINs ──────────────────
async function buildParentPath(
  db: any,
  type: "summary" | "keyword" | "video",
  item: Record<string, any>
): Promise<string> {
  try {
    if (type === "summary" || type === "keyword") {
      // summary.topic_id → topic.section_id → section.semester_id → semester.course_id → course.name
      const topicId = item.topic_id;
      if (!topicId) return "";
      const { data: topic } = await db.from("topics").select("name, section_id").eq("id", topicId).single();
      if (!topic) return "";
      const { data: section } = await db.from("sections").select("name, semester_id").eq("id", topic.section_id).single();
      if (!section) return "";
      const { data: semester } = await db.from("semesters").select("name, course_id").eq("id", section.semester_id).single();
      if (!semester) return "";
      const { data: course } = await db.from("courses").select("name").eq("id", semester.course_id).single();
      if (!course) return "";
      return `${course.name} > ${semester.name} > ${topic.name}`;
    }
    if (type === "video") {
      // video.summary_id → summary.topic_id → ... → course.name
      const summaryId = item.summary_id;
      if (!summaryId) return "";
      const { data: summary } = await db.from("summaries").select("title, topic_id").eq("id", summaryId).single();
      if (!summary) return summary?.title || "";
      const { data: topic } = await db.from("topics").select("name").eq("id", summary.topic_id).single();
      return topic ? `${topic.name} > ${summary.title}` : summary.title;
    }
  } catch {
    // Non-fatal: return empty path if JOINs fail
  }
  return "";
}

// ── GET /search ──────────────────────────────────────────────
searchRoutes.get("/search", async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const q = c.req.query("q")?.trim();
  const type = c.req.query("type") || "all";

  if (!q || q.length < 2) {
    return err(c, "Query 'q' must be at least 2 characters", 400);
  }

  const pattern = `%${q}%`;
  const results: any[] = [];

  try {
    // ── Summaries ─────────────────────────────────────────
    if (type === "all" || type === "summaries") {
      const { data: summaries } = await db
        .from("summaries")
        .select("id, title, content_markdown, topic_id")
        .is("deleted_at", null)
        .or(`title.ilike.${pattern},content_markdown.ilike.${pattern}`)
        .limit(type === "all" ? 7 : 20);

      for (const s of summaries || []) {
        const inTitle = s.title?.toLowerCase().includes(q.toLowerCase());
        const snippet = inTitle
          ? s.title
          : (s.content_markdown || "").substring(0, 120).replace(/\n/g, " ") + "...";
        const parent_path = await buildParentPath(db, "summary", s);
        results.push({
          type: "summary",
          id: s.id,
          title: s.title,
          snippet,
          parent_path,
          _score: inTitle ? 2 : 1,
        });
      }
    }

    // ── Keywords ──────────────────────────────────────────
    if (type === "all" || type === "keywords") {
      const { data: keywords } = await db
        .from("keywords")
        .select("id, name, definition, topic_id")
        .is("deleted_at", null)
        .or(`name.ilike.${pattern},definition.ilike.${pattern}`)
        .limit(type === "all" ? 7 : 20);

      for (const k of keywords || []) {
        const inName = k.name?.toLowerCase().includes(q.toLowerCase());
        const snippet = inName
          ? k.definition?.substring(0, 120) || k.name
          : (k.definition || "").substring(0, 120) + "...";
        const parent_path = await buildParentPath(db, "keyword", k);
        results.push({
          type: "keyword",
          id: k.id,
          title: k.name,
          snippet,
          parent_path,
          _score: inName ? 2 : 1,
        });
      }
    }

    // ── Videos ────────────────────────────────────────────
    if (type === "all" || type === "videos") {
      const { data: videos } = await db
        .from("videos")
        .select("id, title, summary_id")
        .is("deleted_at", null)
        .ilike("title", pattern)
        .limit(type === "all" ? 6 : 20);

      for (const v of videos || []) {
        const parent_path = await buildParentPath(db, "video", v);
        results.push({
          type: "video",
          id: v.id,
          title: v.title,
          snippet: v.title,
          parent_path,
          _score: 2,
        });
      }
    }

    // ── Ordenar por relevância (title match > content match) ──
    results.sort((a, b) => b._score - a._score);

    // Remover campo interno _score e limitar a 20
    const final = results.slice(0, 20).map(({ _score, ...r }) => r);

    return ok(c, { results: final });
  } catch (e: any) {
    return err(c, `Search error: ${e.message}`, 500);
  }
});

// ── GET /trash ───────────────────────────────────────────────
searchRoutes.get("/trash", async (c: Context) => {
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

  const items: any[] = [];

  const targets = type && TABLE_MAP[type]
    ? [{ key: type, ...TABLE_MAP[type] }]
    : Object.entries(TABLE_MAP).map(([key, v]) => ({ key, ...v }));

  try {
    for (const target of targets) {
      const { data } = await db
        .from(target.table)
        .select(`id, ${target.titleField}, deleted_at`)
        .not("deleted_at", "is", null)
        .order("deleted_at", { ascending: false })
        .limit(50);

      for (const item of data || []) {
        items.push({
          id: item.id,
          type: target.key,
          title: item[target.titleField] || item.id,
          deleted_at: item.deleted_at,
        });
      }
    }

    // Ordenar por deleted_at DESC (mais recente primeiro)
    items.sort((a, b) =>
      new Date(b.deleted_at).getTime() - new Date(a.deleted_at).getTime()
    );

    return ok(c, { items: items.slice(0, 50) });
  } catch (e: any) {
    return err(c, `Trash error: ${e.message}`, 500);
  }
});

// ── POST /restore/:table/:id ─────────────────────────────────
searchRoutes.post("/restore/:table/:id", async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const tableParam = c.req.param("table");
  const id = c.req.param("id");

  // Validar whitelist
  const realTable = RESTORE_WHITELIST[tableParam];
  if (!realTable) {
    return err(c, `Table '${tableParam}' not allowed. Allowed: ${Object.keys(RESTORE_WHITELIST).join(", ")}`, 400);
  }

  // Validar permissões: verificar role do usuário
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
      .not("deleted_at", "is", null) // só restaura se estiver deletado
      .select()
      .single();

    if (error) return err(c, error.message, 400);
    if (!data) return err(c, "Item not found or already active", 404);

    return ok(c, { restored: true, item: data });
  } catch (e: any) {
    return err(c, `Restore error: ${e.message}`, 500);
  }
});

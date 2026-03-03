/**
 * routes/search/search.ts — Global search endpoint
 *
 * GET /search?q=texto&type=all|summaries|videos|keywords
 *
 * N-1 FIX: Search queries + path resolution run in parallel.
 * O-1 FIX: or() filter values quoted.
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, PREFIX } from "../../db.ts";
import { escapeLike, escapeOrQuote, batchResolvePaths } from "./helpers.ts";

export const searchEndpoint = new Hono();

searchEndpoint.get(`${PREFIX}/search`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const q = c.req.query("q")?.trim();
  const type = c.req.query("type") || "all";
  if (!q || q.length < 2) return err(c, "Query 'q' must be at least 2 characters", 400);

  const pattern = `%${escapeLike(q)}%`;
  const orPattern = escapeOrQuote(pattern);

  try {
    const [summariesResult, keywordsResult, videosResult] = await Promise.all([
      type === "all" || type === "summaries"
        ? db.from("summaries").select("id, title, content_markdown, topic_id")
            .is("deleted_at", null)
            .or(`title.ilike."${orPattern}",content_markdown.ilike."${orPattern}"`)
            .limit(type === "all" ? 7 : 20)
        : Promise.resolve({ data: [] }),
      type === "all" || type === "keywords"
        ? db.from("keywords").select("id, name, definition, summary_id")
            .is("deleted_at", null)
            .or(`name.ilike."${orPattern}",definition.ilike."${orPattern}"`)
            .limit(type === "all" ? 7 : 20)
        : Promise.resolve({ data: [] }),
      type === "all" || type === "videos"
        ? db.from("videos").select("id, title, summary_id")
            .is("deleted_at", null).ilike("title", pattern)
            .limit(type === "all" ? 6 : 20)
        : Promise.resolve({ data: [] }),
    ]);

    const summaries = summariesResult.data ?? [];
    const keywords = keywordsResult.data ?? [];
    const videos = videosResult.data ?? [];

    const topicIds: string[] = [];
    const summaryIdsForPaths: string[] = [];
    for (const s of summaries) { if (s.topic_id) topicIds.push(s.topic_id); }
    for (const k of keywords) { if (k.summary_id) summaryIdsForPaths.push(k.summary_id); }
    for (const v of videos) { if (v.summary_id) summaryIdsForPaths.push(v.summary_id); }

    const { topicPathMap, summaryPathMap } = await batchResolvePaths(db, topicIds, summaryIdsForPaths);

    const results: { type: string; id: string; title: string; snippet: string; parent_path: string; _score: number }[] = [];
    const qLower = q.toLowerCase();

    for (const s of summaries) {
      const inTitle = s.title?.toLowerCase().includes(qLower);
      const snippet = inTitle ? s.title : (s.content_markdown || "").substring(0, 120).replace(/\n/g, " ") + "...";
      results.push({ type: "summary", id: s.id, title: s.title, snippet, parent_path: s.topic_id ? (topicPathMap.get(s.topic_id) ?? "") : "", _score: inTitle ? 2 : 1 });
    }
    for (const k of keywords) {
      const inName = k.name?.toLowerCase().includes(qLower);
      const snippet = inName ? k.definition?.substring(0, 120) || k.name : (k.definition || "").substring(0, 120) + "...";
      results.push({ type: "keyword", id: k.id, title: k.name, snippet, parent_path: k.summary_id ? (summaryPathMap.get(k.summary_id) ?? "") : "", _score: inName ? 2 : 1 });
    }
    for (const v of videos) {
      results.push({ type: "video", id: v.id, title: v.title, snippet: v.title, parent_path: v.summary_id ? (summaryPathMap.get(v.summary_id) ?? "") : "", _score: 2 });
    }

    results.sort((a, b) => b._score - a._score);
    const final = results.slice(0, 20).map(({ _score, ...r }) => r);
    return ok(c, { results: final });
  } catch (e: any) {
    return err(c, `Search error: ${e.message}`, 500);
  }
});

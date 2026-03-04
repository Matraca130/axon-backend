/**
 * routes/search/search.ts — Institution-scoped search endpoint
 *
 * GET /search?q=texto&type=all|summaries|videos|keywords
 *
 * H-4 FIX: Now calls the search_scoped() RPC which:
 *   - Scopes results to the caller's accessible institutions
 *   - Uses auth.uid() internally (no user-id spoofing possible)
 *   - Resolves parent paths in SQL (eliminates batchResolvePaths)
 *   - Escapes ILIKE wildcards server-side
 *
 * Previous fixes preserved:
 *   N-1: Parallel queries (now single RPC call, even better)
 *   O-1: or() filter quoting (now handled in SQL)
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, PREFIX } from "../../db.ts";

export const searchEndpoint = new Hono();

searchEndpoint.get(`${PREFIX}/search`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const q = c.req.query("q")?.trim();
  const type = c.req.query("type") || "all";
  if (!q || q.length < 2) return err(c, "Query 'q' must be at least 2 characters", 400);

  const validTypes = ["all", "summaries", "keywords", "videos"];
  if (!validTypes.includes(type)) {
    return err(c, `Invalid type. Allowed: ${validTypes.join(", ")}`, 400);
  }

  try {
    // H-4 FIX: Single RPC call replaces 3 direct queries + batchResolvePaths.
    // search_scoped() uses auth.uid() internally to scope to caller's institutions.
    // ILIKE wildcard escaping is done inside the SQL function.
    const { data, error } = await db.rpc("search_scoped", {
      p_query: q,
      p_type: type,
      p_limit: 20,
    });

    if (error) return err(c, `Search error: ${error.message}`, 500);

    // Map RPC column names to the API response format
    const results = (data ?? []).map(
      (row: { result_type: string; result_id: string; title: string; snippet: string; parent_path: string }) => ({
        type: row.result_type,
        id: row.result_id,
        title: row.title,
        snippet: row.snippet,
        parent_path: row.parent_path,
      }),
    );

    return ok(c, { results });
  } catch (e: any) {
    return err(c, `Search error: ${e.message}`, 500);
  }
});

/**
 * routes/search/index.ts — Search module combiner
 *
 * Mounts all search sub-modules into a single Hono router.
 * Replaces the old monolithic routes-search.ts (13KB).
 *
 * Sub-modules:
 *   helpers.ts        — escapeLike, escapeOrQuote, batchResolvePaths
 *   search.ts         — GET /search (global search with parallel queries)
 *   trash-restore.ts  — GET /trash + POST /restore/:table/:id
 */

import { Hono } from "npm:hono";
import { searchEndpoint } from "./search.ts";
import { trashRestoreRoutes } from "./trash-restore.ts";

const searchRoutes = new Hono();

searchRoutes.route("/", searchEndpoint);
searchRoutes.route("/", trashRestoreRoutes);

export { searchRoutes };

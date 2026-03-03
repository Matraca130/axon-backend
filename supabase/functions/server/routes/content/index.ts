/**
 * routes/content/index.ts — Content module combiner
 *
 * Mounts all content sub-modules into a single Hono router.
 * Replaces the old monolithic routes-content.tsx (17KB).
 *
 * Sub-modules:
 *   crud.ts               — 10 registerCrud calls (courses→subtopics)
 *   keyword-connections.ts — manual CRUD for keyword_connections
 *   prof-notes.ts          — manual CRUD for kw_prof_notes
 *   reorder.ts             — PUT /reorder (bulk reorder)
 *   content-tree.ts        — GET /content-tree (nested hierarchy)
 */

import { Hono } from "npm:hono";
import { contentCrudRoutes } from "./crud.ts";
import { keywordConnectionRoutes } from "./keyword-connections.ts";
import { profNotesRoutes } from "./prof-notes.ts";
import { reorderRoutes } from "./reorder.ts";
import { contentTreeRoutes } from "./content-tree.ts";

const content = new Hono();

content.route("/", contentCrudRoutes);
content.route("/", keywordConnectionRoutes);
content.route("/", profNotesRoutes);
content.route("/", reorderRoutes);
content.route("/", contentTreeRoutes);

export { content };

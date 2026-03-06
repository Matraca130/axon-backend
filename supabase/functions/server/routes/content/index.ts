/**
 * routes/content/index.ts — Content module combiner
 *
 * Mounts all content sub-modules into a single Hono router.
 * Replaces the old monolithic routes-content.tsx (17KB).
 *
 * IMPORTANT: keywordSearchRoutes is mounted BEFORE contentCrudRoutes
 * so that `/keyword-search` is registered before the CRUD factory's
 * `/keywords/:id`. While the flat naming already avoids collision,
 * this order provides defense-in-depth.
 *
 * Sub-modules:
 *   keyword-search.ts      — GET /keyword-search (cross-summary search, RPC)
 *   crud.ts               — 10 registerCrud calls (courses→subtopics)
 *   keyword-connections.ts — manual CRUD for keyword_connections (V2: +type)
 *   prof-notes.ts          — manual CRUD for kw_prof_notes
 *   reorder.ts             — PUT /reorder (bulk reorder)
 *   content-tree.ts        — GET /content-tree (nested hierarchy)
 *   flashcards-by-topic.ts — GET /flashcards-by-topic (PERF C1: batch load)
 */

import { Hono } from "npm:hono";
import { keywordSearchRoutes } from "./keyword-search.ts";
import { contentCrudRoutes } from "./crud.ts";
import { keywordConnectionRoutes } from "./keyword-connections.ts";
import { profNotesRoutes } from "./prof-notes.ts";
import { reorderRoutes } from "./reorder.ts";
import { contentTreeRoutes } from "./content-tree.ts";
import { flashcardsByTopicRoutes } from "./flashcards-by-topic.ts";

const content = new Hono();

// Search routes FIRST (defense-in-depth against param route collision)
content.route("/", keywordSearchRoutes);
content.route("/", contentCrudRoutes);
content.route("/", keywordConnectionRoutes);
content.route("/", profNotesRoutes);
content.route("/", reorderRoutes);
content.route("/", contentTreeRoutes);
content.route("/", flashcardsByTopicRoutes);

export { content };

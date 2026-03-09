/**
 * routes/content/index.ts — Content module combiner
 *
 * Mounts all content sub-modules into a single Hono router.
 * Replaces the old monolithic routes-content.tsx (17KB).
 *
 * IMPORTANT: keywordSearchRoutes and subtopicsBatchRoutes are mounted
 * BEFORE contentCrudRoutes so that `/keyword-search` and `/subtopics-batch`
 * are registered before the CRUD factory's `/keywords/:id` and
 * `/subtopics/:id`. While the flat naming already avoids collision,
 * this order provides defense-in-depth.
 *
 * Sub-modules:
 *   keyword-search.ts      — GET /keyword-search (cross-summary search, RPC)
 *   subtopics-batch.ts     — GET /subtopics-batch (H-1: batch load by keyword_ids)
 *   crud.ts               — 10 registerCrud calls (courses→subtopics)
 *   keyword-connections.ts — manual CRUD for keyword_connections (V2: +type)
 *   prof-notes.ts          — manual CRUD for kw_prof_notes
 *   reorder.ts             — PUT /reorder (bulk reorder)
 *   content-tree.ts        — GET /content-tree (nested hierarchy)
 *   flashcards-by-topic.ts — GET /flashcards-by-topic (PERF C1: batch load)
 *   flashcard-mappings.ts  — GET /flashcard-mappings (P0: lightweight id→subtopic mapping)
 */

import { Hono } from "npm:hono";
import { keywordSearchRoutes } from "./keyword-search.ts";
import { subtopicsBatchRoutes } from "./subtopics-batch.ts";
import { contentCrudRoutes } from "./crud.ts";
import { keywordConnectionRoutes } from "./keyword-connections.ts";
import { profNotesRoutes } from "./prof-notes.ts";
import { reorderRoutes } from "./reorder.ts";
import { contentTreeRoutes } from "./content-tree.ts";
import { flashcardsByTopicRoutes } from "./flashcards-by-topic.ts";
import { flashcardMappingRoutes } from "./flashcard-mappings.ts";

const content = new Hono();

// Search + batch routes FIRST (defense-in-depth against param route collision)
content.route("/", keywordSearchRoutes);
content.route("/", subtopicsBatchRoutes);
content.route("/", contentCrudRoutes);
content.route("/", keywordConnectionRoutes);
content.route("/", profNotesRoutes);
content.route("/", reorderRoutes);
content.route("/", contentTreeRoutes);
content.route("/", flashcardsByTopicRoutes);
content.route("/", flashcardMappingRoutes);

export { content };

/**
 * routes/ai/index.ts — AI module combiner
 *
 * Mounts all AI sub-modules into a single Hono router.
 *
 * Sub-modules:
 *   generate.ts     — POST /ai/generate
 *   ingest.ts       — POST /ai/ingest-embeddings
 *   chat.ts         — POST /ai/rag-chat
 *   list-models.ts  — GET  /ai/list-models (diagnostic)
 */

import { Hono } from "npm:hono";
import { aiGenerateRoutes } from "./generate.ts";
import { aiIngestRoutes } from "./ingest.ts";
import { aiChatRoutes } from "./chat.ts";
import { aiListModelsRoutes } from "./list-models.ts";

const aiRoutes = new Hono();

aiRoutes.route("/", aiGenerateRoutes);
aiRoutes.route("/", aiIngestRoutes);
aiRoutes.route("/", aiChatRoutes);
aiRoutes.route("/", aiListModelsRoutes);

export { aiRoutes };

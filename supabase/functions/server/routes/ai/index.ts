/**
 * routes/ai/index.ts — AI module combiner
 *
 * Mounts all AI sub-modules into a single Hono router.
 * Follows the same pattern as routes/study/index.ts and routes/content/index.ts.
 *
 * Sub-modules:
 *   generate.ts — POST /ai/generate (adaptive quiz/flashcard generation)
 *   ingest.ts   — POST /ai/ingest-embeddings (batch embedding pipeline)
 *   chat.ts     — POST /ai/rag-chat (hybrid search + adaptive chat)
 *
 * PF-03 FIX: Created this combiner file instead of adding 3 separate
 * imports to the main index.ts, matching the existing backend pattern.
 */

import { Hono } from "npm:hono";
import { aiGenerateRoutes } from "./generate.ts";
import { aiIngestRoutes } from "./ingest.ts";
import { aiChatRoutes } from "./chat.ts";

const aiRoutes = new Hono();

aiRoutes.route("/", aiGenerateRoutes);
aiRoutes.route("/", aiIngestRoutes);
aiRoutes.route("/", aiChatRoutes);

export { aiRoutes };

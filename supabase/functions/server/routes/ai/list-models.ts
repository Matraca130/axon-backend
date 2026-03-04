/**
 * routes/ai/list-models.ts — Diagnostic: list available Gemini models
 *
 * GET /ai/list-models
 *   Returns all models available for the configured GEMINI_API_KEY,
 *   filtered to show only embedding-capable models.
 *
 * This is a diagnostic route to debug which embedding models
 * are available (text-embedding-004/005 both return 404).
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, PREFIX } from "../../db.ts";
import { getApiKey } from "../../gemini.ts";

export const aiListModelsRoutes = new Hono();

aiListModelsRoutes.get(`${PREFIX}/ai/list-models`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;

  try {
    const key = getApiKey();
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`;

    const res = await fetch(url);
    if (!res.ok) {
      const errBody = await res.text();
      return err(c, `ListModels failed ${res.status}: ${errBody}`, res.status);
    }

    const data = await res.json();
    const allModels = data.models || [];

    // Filter to embedding models
    const embeddingModels = allModels.filter((m: any) =>
      m.supportedGenerationMethods?.includes("embedContent") ||
      m.name?.includes("embedding")
    );

    // Also show all model names for reference
    const allModelNames = allModels.map((m: any) => ({
      name: m.name,
      displayName: m.displayName,
      methods: m.supportedGenerationMethods,
    }));

    return ok(c, {
      embedding_models: embeddingModels.map((m: any) => ({
        name: m.name,
        displayName: m.displayName,
        methods: m.supportedGenerationMethods,
        outputTokenLimit: m.outputTokenLimit,
      })),
      total_models: allModels.length,
      all_model_names: allModelNames,
    });
  } catch (e) {
    return err(c, `ListModels error: ${(e as Error).message}`, 500);
  }
});

/**
 * routes/ai/re-embed-all.ts — Temporary route for batch re-embedding
 *
 * POST /ai/re-embed-all
 *   Requires: owner or admin role
 *   Re-embeds ALL chunks and summaries using the new OpenAI model.
 *
 * This route is TEMPORARY — delete after migration is complete.
 *
 * D57: OpenAI text-embedding-3-large 1536d
 * D58: In-place migration
 * D62: Normal API (not batch) with rate limiting
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, PREFIX, getAdminClient } from "../../db.ts";
import {
  requireInstitutionRole,
  isDenied,
} from "../../auth-helpers.ts";
import { generateEmbedding, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "../../openai-embeddings.ts";

export const aiReEmbedRoutes = new Hono();

const DELAY_BETWEEN_EMBEDS_MS = 100;

aiReEmbedRoutes.post(`${PREFIX}/ai/re-embed-all`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  // Resolve institution from user's membership
  const { data: membership } = await db
    .from("memberships")
    .select("institution_id, role")
    .eq("user_id", user.id)
    .eq("is_active", true)
    .limit(1)
    .single();

  if (!membership) {
    return err(c, "No active membership found", 400);
  }

  // Only owner/admin can re-embed
  const roleCheck = await requireInstitutionRole(
    db, user.id, membership.institution_id, ["owner", "admin"],
  );
  if (isDenied(roleCheck)) {
    return err(c, roleCheck.message, roleCheck.status);
  }

  const t0 = Date.now();
  const adminDb = getAdminClient();
  const results = {
    chunks: { total: 0, success: 0, failed: 0, errors: [] as string[] },
    summaries: { total: 0, success: 0, failed: 0, errors: [] as string[] },
    model: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    elapsed_ms: 0,
  };

  // ── Re-embed chunks ─────────────────────────────────────────
  const { data: chunks, error: chunksErr } = await adminDb
    .from("chunks")
    .select("id, content")
    .is("embedding", null)
    .order("created_at", { ascending: true });

  if (chunksErr) {
    return err(c, `Failed to fetch chunks: ${chunksErr.message}`, 500);
  }

  results.chunks.total = chunks?.length ?? 0;

  for (const chunk of chunks ?? []) {
    try {
      const embedding = await generateEmbedding(chunk.content);

      const { error: updateErr } = await adminDb
        .from("chunks")
        .update({ embedding: JSON.stringify(embedding) })
        .eq("id", chunk.id);

      if (updateErr) {
        results.chunks.failed++;
        results.chunks.errors.push(`chunk ${chunk.id}: ${updateErr.message}`);
      } else {
        results.chunks.success++;
      }

      // Rate limit safety
      await new Promise((r) => setTimeout(r, DELAY_BETWEEN_EMBEDS_MS));
    } catch (e) {
      results.chunks.failed++;
      results.chunks.errors.push(`chunk ${chunk.id}: ${(e as Error).message}`);
    }
  }

  // ── Re-embed summaries ──────────────────────────────────────
  const { data: summaries, error: summErr } = await adminDb
    .from("summaries")
    .select("id, title, content_markdown")
    .is("embedding", null)
    .not("content_markdown", "is", null)
    .order("created_at", { ascending: true });

  if (summErr) {
    // Don't fail entirely — chunks may have succeeded
    results.summaries.errors.push(`Fetch error: ${summErr.message}`);
  }

  results.summaries.total = summaries?.length ?? 0;

  for (const s of summaries ?? []) {
    try {
      const text = s.title
        ? `${s.title}. ${s.content_markdown}`
        : s.content_markdown;

      const embedding = await generateEmbedding(text);

      const { error: updateErr } = await adminDb
        .from("summaries")
        .update({ embedding: JSON.stringify(embedding) })
        .eq("id", s.id);

      if (updateErr) {
        results.summaries.failed++;
        results.summaries.errors.push(`summary ${s.id}: ${updateErr.message}`);
      } else {
        results.summaries.success++;
      }

      await new Promise((r) => setTimeout(r, DELAY_BETWEEN_EMBEDS_MS));
    } catch (e) {
      results.summaries.failed++;
      results.summaries.errors.push(`summary ${s.id}: ${(e as Error).message}`);
    }
  }

  results.elapsed_ms = Date.now() - t0;

  console.info(
    `[Re-Embed] Done: ${results.chunks.success}/${results.chunks.total} chunks, ` +
    `${results.summaries.success}/${results.summaries.total} summaries, ` +
    `${results.elapsed_ms}ms`,
  );

  return ok(c, results);
});

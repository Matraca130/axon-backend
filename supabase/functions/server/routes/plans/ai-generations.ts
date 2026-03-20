/**
 * routes/plans/ai-generations.ts — AI generation audit log
 *
 * LIST + POST only (immutable records).
 * P-2 FIX: Pagination capped at 500.
 */

import { Hono } from "npm:hono";
import { authenticate, ok, err, safeJson, PREFIX } from "../../db.ts";
import { safeErr } from "../../lib/safe-error.ts";
import { isUuid, isNonEmpty, isNonNegInt, validateFields } from "../../validate.ts";
import type { Context } from "npm:hono";

export const aiGenerationRoutes = new Hono();

const MAX_PAGINATION_LIMIT = 500;
const aiGenBase = `${PREFIX}/ai-generations`;

aiGenerationRoutes.get(aiGenBase, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const institutionId = c.req.query("institution_id");
  if (!isUuid(institutionId)) return err(c, "institution_id must be a valid UUID", 400);

  let query = db.from("ai_generations").select("*")
    .eq("institution_id", institutionId)
    .order("created_at", { ascending: false });

  const genType = c.req.query("generation_type");
  if (genType) query = query.eq("generation_type", genType);

  let limit = parseInt(c.req.query("limit") ?? "50", 10);
  if (isNaN(limit) || limit < 1) limit = 50;
  if (limit > MAX_PAGINATION_LIMIT) limit = MAX_PAGINATION_LIMIT;
  let offset = parseInt(c.req.query("offset") ?? "0", 10);
  if (isNaN(offset) || offset < 0) offset = 0;
  query = query.range(offset, offset + limit - 1);

  const { data, error } = await query;
  if (error) return safeErr(c, "List ai_generations", error);
  return ok(c, data);
});

aiGenerationRoutes.post(aiGenBase, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);
  if (!isUuid(body.institution_id)) return err(c, "institution_id must be a valid UUID", 400);
  if (!isNonEmpty(body.generation_type)) return err(c, "generation_type must be a non-empty string", 400);

  const row: Record<string, unknown> = {
    institution_id: body.institution_id, requested_by: user.id, generation_type: body.generation_type,
  };

  const { fields, error: valErr } = validateFields(body, [
    { key: "source_summary_id", check: isUuid, msg: "must be a valid UUID" },
    { key: "source_keyword_id", check: isUuid, msg: "must be a valid UUID" },
    { key: "items_generated", check: isNonNegInt, msg: "must be a non-negative integer" },
    { key: "model_used", check: isNonEmpty, msg: "must be a non-empty string" },
  ]);
  if (valErr) return err(c, valErr, 400);
  Object.assign(row, fields);

  const { data, error } = await db.from("ai_generations").insert(row).select().single();
  if (error) return safeErr(c, "Create ai_generation", error);
  return ok(c, data, 201);
});

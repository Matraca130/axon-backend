/**
 * routes/plans/diagnostics.ts — Summary diagnostics
 *
 * LIST + POST only (immutable AI diagnostic results).
 */

import { Hono } from "npm:hono";
import { authenticate, ok, err, safeJson, PREFIX } from "../../db.ts";
import { safeErr } from "../../lib/safe-error.ts";
import { isUuid, isNonEmpty, isObj, validateFields } from "../../validate.ts";
import type { Context } from "npm:hono";

export const diagnosticRoutes = new Hono();

const diagBase = `${PREFIX}/summary-diagnostics`;

diagnosticRoutes.get(diagBase, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const summaryId = c.req.query("summary_id");
  if (!isUuid(summaryId)) return err(c, "summary_id must be a valid UUID", 400);

  let query = db.from("summary_diagnostics").select("*")
    .eq("summary_id", summaryId)
    .order("created_at", { ascending: false });

  const diagType = c.req.query("diagnostic_type");
  if (diagType) query = query.eq("diagnostic_type", diagType);

  const { data, error } = await query;
  if (error) return safeErr(c, "List summary_diagnostics", error);
  return ok(c, data);
});

diagnosticRoutes.post(diagBase, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);
  if (!isUuid(body.summary_id)) return err(c, "summary_id must be a valid UUID", 400);
  if (!isNonEmpty(body.content)) return err(c, "content must be a non-empty string", 400);

  const row: Record<string, unknown> = {
    summary_id: body.summary_id, requested_by: user.id, content: body.content,
  };

  const { fields, error: valErr } = validateFields(body, [
    { key: "ai_generation_id", check: isUuid, msg: "must be a valid UUID" },
    { key: "parent_diagnostic_id", check: isUuid, msg: "must be a valid UUID" },
    { key: "diagnostic_type", check: isNonEmpty, msg: "must be a non-empty string" },
    { key: "structured_data", check: isObj, msg: "must be a JSON object" },
    { key: "model_used", check: isNonEmpty, msg: "must be a non-empty string" },
    { key: "prompt_version", check: isNonEmpty, msg: "must be a non-empty string" },
  ]);
  if (valErr) return err(c, valErr, 400);
  Object.assign(row, fields);

  const { data, error } = await db.from("summary_diagnostics").insert(row).select().single();
  if (error) return safeErr(c, "Create summary_diagnostic", error);
  return ok(c, data, 201);
});

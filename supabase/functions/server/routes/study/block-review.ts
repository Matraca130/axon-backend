/**
 * routes/study/block-review.ts — Per-block quiz BKT mastery update
 *
 * POST /server/block-review
 *
 * Receives an array of per-question results from the block quiz modal
 * and applies BKT v4 sequentially to update block_mastery_states.
 *
 * Independent from keyword-based bkt_states — this is the student's
 * mastery of a specific summary block, not a subtopic/keyword.
 *
 * Uses the same computeBktV4Update() engine as batch-review.ts.
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, safeJson, PREFIX } from "../../db.ts";
import { isUuid } from "../../validate.ts";
import { safeErr } from "../../lib/safe-error.ts";
import { computeBktV4Update } from "../../lib/bkt-v4.ts";
import { requireInstitutionRole, isDenied, ALL_ROLES } from "../../auth-helpers.ts";
import { atomicUpsert } from "./progress.ts";

export const blockReviewRoutes = new Hono();

// ── Constants ────────────────────────────────────────────────────────
const MAX_RESULTS = 20;

// ── Types ────────────────────────────────────────────────────────────
interface BlockReviewItem {
  question_id: string | null;
  is_correct: boolean;
  time_taken_ms?: number;
}

// ── POST /block-review ──────────────────────────────────────────────

blockReviewRoutes.post(`${PREFIX}/block-review`, async (c: Context) => {
  // ── 1. Auth ────────────────────────────────────────────────
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  // ── 2. Parse & validate body ──────────────────────────────
  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const blockId = body.block_id;
  const summaryId = body.summary_id;
  const results = body.results;

  if (!isUuid(blockId)) return err(c, "block_id must be a valid UUID", 400);
  if (!isUuid(summaryId)) return err(c, "summary_id must be a valid UUID", 400);

  if (!Array.isArray(results) || results.length === 0) {
    return err(c, "results must be a non-empty array", 400);
  }
  if (results.length > MAX_RESULTS) {
    return err(c, `results array exceeds max size of ${MAX_RESULTS}`, 400);
  }

  // Validate each result item
  const validatedResults: BlockReviewItem[] = [];
  for (let i = 0; i < results.length; i++) {
    const item = results[i];
    if (!item || typeof item !== "object") {
      return err(c, `results[${i}] must be an object`, 400);
    }
    if (typeof item.is_correct !== "boolean") {
      return err(c, `results[${i}].is_correct must be a boolean`, 400);
    }
    validatedResults.push({
      question_id: typeof item.question_id === "string" ? item.question_id : null,
      is_correct: item.is_correct,
      time_taken_ms: typeof item.time_taken_ms === "number" ? item.time_taken_ms : undefined,
    });
  }

  // ── 3. Verify block belongs to summary ────────────────────
  const { data: block, error: blockErr } = await db
    .from("summary_blocks")
    .select("id, summary_id")
    .eq("id", blockId)
    .eq("summary_id", summaryId)
    .eq("is_active", true)
    .single();

  if (blockErr || !block) {
    return err(c, "Block not found or does not belong to this summary", 404);
  }

  // ── 4. Institution membership check ───────────────────────
  const { data: summary, error: summaryErr } = await db
    .from("summaries")
    .select("institution_id")
    .eq("id", summaryId)
    .single();

  if (summaryErr || !summary) return err(c, "Summary not found", 404);

  const roleCheck = await requireInstitutionRole(
    db, user.id, summary.institution_id, ALL_ROLES,
  );
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status);

  // ── 5. Fetch existing block mastery state ─────────────────
  const { data: existing } = await db
    .from("block_mastery_states")
    .select("p_know, max_p_know, total_attempts, correct_attempts")
    .eq("student_id", user.id)
    .eq("block_id", blockId)
    .maybeSingle();

  let currentMastery = existing?.p_know ?? 0;
  let maxReachedMastery = existing?.max_p_know ?? 0;

  // ── 6. Apply BKT v4 sequentially per question ─────────────
  let totalDelta = 0;
  let correctCount = 0;

  for (const item of validatedResults) {
    const bktResult = computeBktV4Update({
      currentMastery,
      maxReachedMastery,
      isCorrect: item.is_correct,
      instrumentType: "quiz",
    });

    currentMastery = bktResult.p_know;
    maxReachedMastery = bktResult.max_p_know;
    totalDelta += bktResult.delta;
    if (item.is_correct) correctCount++;
  }

  const nowIso = new Date().toISOString();

  // ── 7. Upsert final state ─────────────────────────────────
  const row = {
    student_id: user.id,
    block_id: blockId,
    p_know: Math.round(currentMastery * 10000) / 10000,
    max_p_know: Math.round(maxReachedMastery * 10000) / 10000,
    total_attempts: 0,      // seed for INSERT; RPC increments atomically
    correct_attempts: 0,    // seed for INSERT; RPC increments atomically
    last_attempt_at: nowIso,
  };

  const { error: upsertErr } = await atomicUpsert(
    db, "block_mastery_states", "student_id,block_id", row,
  );

  if (upsertErr) return safeErr(c, "Upsert block mastery", upsertErr);

  // ── 8. Atomic increment attempts ──────────────────────────
  let finalTotal = existing?.total_attempts ?? 0;
  let finalCorrect = existing?.correct_attempts ?? 0;

  const { data: rpcData, error: rpcErr } = await db.rpc(
    "increment_block_mastery_attempts",
    {
      p_student_id: user.id,
      p_block_id: blockId,
      p_total_delta: validatedResults.length,
      p_correct_delta: correctCount,
    },
  );

  if (rpcErr) {
    console.error("[block-review] Atomic increment failed:", rpcErr.message);
  } else if (rpcData && rpcData.length > 0) {
    finalTotal = rpcData[0].new_total_attempts;
    finalCorrect = rpcData[0].new_correct_attempts;
  }

  // ── 9. Return result ──────────────────────────────────────
  return ok(c, {
    block_id: blockId,
    p_know: Math.round(currentMastery * 10000) / 10000,
    max_p_know: Math.round(maxReachedMastery * 10000) / 10000,
    delta: Math.round(totalDelta * 10000) / 10000,
    total_attempts: finalTotal,
    correct_attempts: finalCorrect,
  });
});

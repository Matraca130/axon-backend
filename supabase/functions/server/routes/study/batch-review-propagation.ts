/**
 * routes/study/batch-review-propagation.ts — Keyword BKT propagation (spec §4.2)
 *
 * Extracted from batch-review.ts. After a flashcard/quiz review updates its
 * subtopic's BKT state, propagate a weighted BKT update to ALL sibling
 * subtopics under the same keyword. Fire-and-forget: errors are logged and
 * surfaced as warnings in the HTTP response, never thrown.
 *
 * Dedupe note: the orchestrator collapses by keyword_id before calling this
 * function, so each invocation = one keyword. The `precomputedKeywordId`
 * parameter lets the caller skip the lookup entirely.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js";
import { computeBktV4Update } from "../../lib/bkt-v4.ts";
import { BKT_WEIGHTS } from "../../lib/types.ts";

export async function propagateKeywordBkt(
  db: SupabaseClient,
  userId: string,
  itemId: string,
  instrumentType: string,
  isCorrect: boolean,
  sourceSubtopicId: string | undefined,
  precomputedKeywordId?: string,
  nowFn: () => Date = () => new Date(),
): Promise<string | undefined> {
  try {
    if (!["quiz", "flashcard"].includes(instrumentType)) {
      console.warn(`[KW-BKT] Invalid instrumentType: ${instrumentType}`);
      return `Invalid instrumentType: ${instrumentType}`;
    }

    let keywordId: string;
    if (precomputedKeywordId) {
      keywordId = precomputedKeywordId;
    } else {
      const table = instrumentType === "quiz" ? "quiz_questions" : "flashcards";

      const { data: item, error: itemErr } = await db
        .from(table)
        .select("keyword_id")
        .eq("id", itemId)
        .maybeSingle();

      if (itemErr || !item?.keyword_id) {
        if (itemErr) {
          console.error(`[KW-BKT] Failed to look up ${table} keyword_id:`, itemErr.message);
          return `Failed to look up keyword: ${itemErr.message}`;
        }
        return;
      }

      keywordId = item.keyword_id as string;
    }

    const { data: subtopics, error: subErr } = await db
      .from("subtopics")
      .select("id")
      .eq("keyword_id", keywordId)
      .is("deleted_at", null);

    if (subErr || !subtopics || subtopics.length === 0) {
      if (subErr) {
        console.error("[KW-BKT] Failed to look up subtopics:", subErr.message);
        return `Failed to look up subtopics: ${subErr.message}`;
      }
      return;
    }

    const weight = instrumentType === "quiz"
      ? BKT_WEIGHTS.quiz
      : BKT_WEIGHTS.flashcard;

    const nowIso = nowFn().toISOString();

    const targetSubtopics = subtopics.filter(s => s.id !== sourceSubtopicId);
    if (targetSubtopics.length === 0) return;

    const targetIds = targetSubtopics.map(s => s.id);

    const { data: allBktStates, error: batchErr } = await db
      .from("bkt_states")
      .select("subtopic_id, p_know, max_p_know, total_attempts, correct_attempts, p_transit, p_slip, p_guess")
      .eq("student_id", userId)
      .in("subtopic_id", targetIds);

    if (batchErr) {
      console.error("[KW-BKT] Batch fetch failed:", batchErr.message);
      return `Batch fetch failed: ${batchErr.message}`;
    }

    const bktMap = new Map(
      (allBktStates ?? []).map(s => [s.subtopic_id, s])
    );

    const upsertRows = [];
    for (const sub of targetSubtopics) {
      const existing = bktMap.get(sub.id);
      const currentMastery = existing?.p_know ?? 0;
      const maxReachedMastery = existing?.max_p_know ?? 0;

      const bktResult = computeBktV4Update({
        currentMastery,
        maxReachedMastery,
        isCorrect,
        instrumentType: instrumentType === "quiz" ? "quiz" : "flashcard",
      });

      const weightedDelta = bktResult.delta * weight;
      const weightedPKnow = Math.max(0, Math.min(1, currentMastery + weightedDelta));
      const weightedMaxPKnow = Math.max(maxReachedMastery, weightedPKnow);

      upsertRows.push({
        student_id: userId,
        subtopic_id: sub.id,
        p_know: Math.round(weightedPKnow * 10000) / 10000,
        max_p_know: Math.round(weightedMaxPKnow * 10000) / 10000,
        p_transit: existing?.p_transit ?? 0.18,
        p_slip: existing?.p_slip ?? 0.10,
        p_guess: existing?.p_guess ?? 0.25,
        delta: Math.round(weightedDelta * 10000) / 10000,
        total_attempts: (existing?.total_attempts ?? 0) + 1,
        correct_attempts: (existing?.correct_attempts ?? 0) + (isCorrect ? 1 : 0),
        last_attempt_at: nowIso,
      });
    }

    if (upsertRows.length > 0) {
      const { error: upsertErr } = await db
        .from("bkt_states")
        .upsert(upsertRows, { onConflict: "student_id,subtopic_id" });

      if (upsertErr) {
        console.error(`[KW-BKT] Batch upsert failed (${upsertRows.length} rows):`, upsertErr.message);
        return `Batch upsert failed: ${upsertErr.message}`;
      }
    }

    return;
  } catch (e) {
    const msg = (e as Error).message;
    console.error("[KW-BKT] Keyword propagation failed:", msg);
    return `Propagation error: ${msg}`;
  }
}

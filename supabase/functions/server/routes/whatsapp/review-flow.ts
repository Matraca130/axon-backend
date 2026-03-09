/**
 * routes/whatsapp/review-flow.ts — Flashcard review state machine (S10)
 *
 * Deterministic Session Mode: bypasses Gemini entirely for ~200ms responses.
 * When a student requests flashcard review, the bot enters flashcard_review
 * mode and presents cards one-by-one with interactive reply buttons.
 *
 * Flow:
 *   1. get_study_queue returns cards → enterReviewMode()
 *   2. Bot sends first card with [Fail / Good / Easy] buttons
 *   3. Student taps button → handleReviewButton()
 *   4. Review persisted, cursor advances, next card sent
 *   5. Queue exhausted OR student says "salir" → handleReviewExit()
 *
 * State stored in whatsapp_sessions.current_context:
 *   {
 *     ghost_session_id: UUID,  // study_sessions row for review persistence
 *     queue: FlashcardItem[],  // ordered cards from get_study_queue
 *     cursor: number,          // index of current card
 *     cards_reviewed: number,  // total reviewed so far
 *     ratings: { "1": n, "3": n, "4": n }  // rating distribution
 *   }
 *
 * AUDIT F5: Ghost session created with session_type='whatsapp_review'
 * FC-04: Exactly 3 buttons per card (WhatsApp max = 3)
 * FC-01: handler.ts routes interactive messages here when mode=flashcard_review
 */

import { getAdminClient } from "../../db.ts";
import { sendText, sendInteractiveButtons } from "./wa-client.ts";
import type { ButtonDef } from "./wa-client.ts";

// ─── Types ───────────────────────────────────────────────

export interface FlashcardItem {
  id: string;
  front_text: string;
  back_text: string;
  keyword_name?: string;
  course_name?: string;
}

export interface ReviewSessionContext {
  ghost_session_id: string;
  queue: FlashcardItem[];
  cursor: number;
  cards_reviewed: number;
  ratings: Record<string, number>; // "1", "3", "4"
}

// ─── Constants ───────────────────────────────────────────

const RATING_BUTTONS: ButtonDef[] = [
  { id: "review_fail", title: "\u274c Fail" },
  { id: "review_good", title: "\u2705 Good" },
  { id: "review_easy", title: "\ud83d\udca1 Easy" },
];

const BUTTON_TO_RATING: Record<string, number> = {
  review_fail: 1,
  review_good: 3,
  review_easy: 4,
};

const SESSION_MODE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours for review sessions

// ─── Enter Review Mode ──────────────────────────────────

/**
 * Creates a ghost study_session and transitions the WhatsApp session
 * to flashcard_review mode. Called from handler.ts when get_study_queue
 * returns cards and we want to start an interactive review.
 *
 * @param phoneHash - Session PK
 * @param phone - Raw phone for sending messages
 * @param userId - Axon user ID
 * @param cards - Flashcard queue from get_study_queue RPC
 * @param sessionVersion - Current optimistic lock version
 * @returns true if mode entered successfully
 */
export async function enterReviewMode(
  phoneHash: string,
  phone: string,
  userId: string,
  cards: FlashcardItem[],
  sessionVersion: number,
): Promise<boolean> {
  const db = getAdminClient();

  if (!cards || cards.length === 0) {
    await sendText(phone, "No tenés flashcards pendientes. \ud83c\udf89 ¡Estás al día!");
    return false;
  }

  // Create ghost study_session (AUDIT F5)
  const { data: ghostSession, error: sessionErr } = await db
    .from("study_sessions")
    .insert({
      student_id: userId,
      session_type: "whatsapp_review",
    })
    .select("id")
    .single();

  if (sessionErr || !ghostSession) {
    console.error(`[WA-ReviewFlow] Ghost session creation failed: ${sessionErr?.message}`);
    await sendText(phone, "Error al iniciar la sesión. Intentá de nuevo. \ud83d\ude14");
    return false;
  }

  // Build review context
  const reviewContext: ReviewSessionContext = {
    ghost_session_id: ghostSession.id,
    queue: cards.slice(0, 50), // Cap at 50 cards per session
    cursor: 0,
    cards_reviewed: 0,
    ratings: { "1": 0, "3": 0, "4": 0 },
  };

  // Update session to flashcard_review mode
  const { error: updateErr } = await db
    .from("whatsapp_sessions")
    .update({
      mode: "flashcard_review",
      current_context: reviewContext,
      current_tool: "flashcard_review",
      version: sessionVersion + 1,
      expires_at: new Date(Date.now() + SESSION_MODE_TTL_MS).toISOString(),
    })
    .eq("phone_hash", phoneHash)
    .eq("version", sessionVersion);

  if (updateErr) {
    console.error(`[WA-ReviewFlow] Session update failed: ${updateErr.message}`);
    await sendText(phone, "Error al iniciar. Intentá de nuevo. \ud83d\ude14");
    return false;
  }

  // Send intro message + first card
  await sendText(
    phone,
    `\ud83d\udcda Sesión de repaso: ${cards.length} flashcards\n\n` +
    `Calificá cada tarjeta:\n` +
    `\u274c Fail = No la sabía\n` +
    `\u2705 Good = La sabía con esfuerzo\n` +
    `\ud83d\udca1 Easy = La sabía al instante\n\n` +
    `Escribí "salir" para terminar antes.`,
  );

  await presentCard(phone, reviewContext);
  return true;
}

// ─── Present Current Card ───────────────────────────────

async function presentCard(
  phone: string,
  ctx: ReviewSessionContext,
): Promise<void> {
  const card = ctx.queue[ctx.cursor];
  if (!card) return;

  const cardNum = ctx.cursor + 1;
  const total = ctx.queue.length;
  const label = card.keyword_name || card.course_name || "";
  const labelStr = label ? ` (${label})` : "";

  // Show front (question)
  const body =
    `\ud83d\udccb ${cardNum}/${total}${labelStr}\n\n` +
    `${card.front_text.slice(0, 800)}\n\n` +
    `\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n` +
    `${card.back_text.slice(0, 600)}`;

  await sendInteractiveButtons(phone, body.slice(0, 1024), RATING_BUTTONS);
}

// ─── Handle Rating Button Press ─────────────────────────

/**
 * Called from handler.ts when a button press arrives during flashcard_review mode.
 * Persists the review, updates context, and sends next card or summary.
 *
 * @returns true if handled (caller should NOT fall through to Agentic Loop)
 */
export async function handleReviewButton(
  phoneHash: string,
  phone: string,
  userId: string,
  buttonPayload: string,
  currentContext: Record<string, unknown>,
  sessionVersion: number,
): Promise<boolean> {
  const db = getAdminClient();

  // Parse context
  const ctx = currentContext as unknown as ReviewSessionContext;
  if (!ctx.ghost_session_id || !ctx.queue) {
    console.warn("[WA-ReviewFlow] Invalid review context, exiting mode");
    await exitReviewMode(phoneHash, phone, ctx, sessionVersion);
    return true;
  }

  // Map button to FSRS rating
  const rating = BUTTON_TO_RATING[buttonPayload];
  if (!rating) {
    // Unknown button — might be from a different interaction
    await sendText(phone, "Usá los botones Fail / Good / Easy para calificar. \ud83d\udc46");
    return true;
  }

  const currentCard = ctx.queue[ctx.cursor];
  if (!currentCard) {
    await exitReviewMode(phoneHash, phone, ctx, sessionVersion);
    return true;
  }

  // Persist review (direct DB, same as tools.ts submit_review)
  try {
    await db.from("reviews").insert({
      session_id: ctx.ghost_session_id,
      item_id: currentCard.id,
      instrument_type: "flashcard",
      grade: rating,
    });
  } catch (e) {
    console.error(`[WA-ReviewFlow] Review insert failed: ${(e as Error).message}`);
    // Non-fatal: continue to next card
  }

  // Update context
  ctx.cursor += 1;
  ctx.cards_reviewed += 1;
  ctx.ratings[String(rating)] = (ctx.ratings[String(rating)] || 0) + 1;

  // Check if queue exhausted
  if (ctx.cursor >= ctx.queue.length) {
    await exitReviewMode(phoneHash, phone, ctx, sessionVersion);
    return true;
  }

  // Save updated context + send next card
  await db
    .from("whatsapp_sessions")
    .update({
      current_context: ctx,
      version: sessionVersion + 1,
      expires_at: new Date(Date.now() + SESSION_MODE_TTL_MS).toISOString(),
    })
    .eq("phone_hash", phoneHash)
    .eq("version", sessionVersion);

  await presentCard(phone, ctx);
  return true;
}

// ─── Handle Exit ("salir" or queue exhausted) ────────────

/**
 * Exits flashcard_review mode, updates study_session stats,
 * and shows a summary to the student.
 */
export async function exitReviewMode(
  phoneHash: string,
  phone: string,
  context: ReviewSessionContext | Record<string, unknown>,
  sessionVersion: number,
): Promise<void> {
  const db = getAdminClient();
  const ctx = context as ReviewSessionContext;

  // Update ghost session with completion stats
  if (ctx.ghost_session_id) {
    const correctCount = (ctx.ratings?.["3"] || 0) + (ctx.ratings?.["4"] || 0);
    try {
      await db
        .from("study_sessions")
        .update({
          completed_at: new Date().toISOString(),
          total_reviews: ctx.cards_reviewed || 0,
          correct_reviews: correctCount,
        })
        .eq("id", ctx.ghost_session_id);
    } catch (e) {
      console.warn(`[WA-ReviewFlow] Session stats update failed: ${(e as Error).message}`);
    }
  }

  // Transition back to conversation mode
  await db
    .from("whatsapp_sessions")
    .update({
      mode: "conversation",
      current_tool: null,
      current_context: {},
      version: sessionVersion + 1,
    })
    .eq("phone_hash", phoneHash)
    .eq("version", sessionVersion);

  // Send summary
  const reviewed = ctx.cards_reviewed || 0;
  const fail = ctx.ratings?.["1"] || 0;
  const good = ctx.ratings?.["3"] || 0;
  const easy = ctx.ratings?.["4"] || 0;
  const total = ctx.queue?.length || 0;

  if (reviewed === 0) {
    await sendText(phone, "Sesión de repaso cancelada. \ud83d\udc4b");
    return;
  }

  const accuracy = reviewed > 0 ? Math.round(((good + easy) / reviewed) * 100) : 0;

  await sendText(
    phone,
    `\u2705 Sesión completada\n\n` +
    `\ud83d\udcca ${reviewed}/${total} tarjetas revisadas\n` +
    `\ud83c\udfaf Precisión: ${accuracy}%\n\n` +
    `\u274c Fail: ${fail}\n` +
    `\u2705 Good: ${good}\n` +
    `\ud83d\udca1 Easy: ${easy}\n\n` +
    (fail > 0
      ? `Las tarjetas fallidas se reprogramaron para pronto. \ud83d\udcaa`
      : `\u00a1Excelente sesión! \ud83c\udf1f`),
  );
}

// ─── Check for Exit Command ─────────────────────────────

/**
 * Returns true if the text message is an exit command during review mode.
 */
export function isExitCommand(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return [
    "salir", "exit", "terminar", "parar", "cancelar",
    "stop", "quit", "fin", "basta",
  ].includes(normalized);
}

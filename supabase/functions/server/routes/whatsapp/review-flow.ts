/**
 * routes/whatsapp/review-flow.ts — Flashcard review state machine (S10)
 *
 * Deterministic Session Mode: bypasses Gemini entirely for ~200ms responses.
 *
 * C8 FIX: Optimistic lock errors now checked in handleReviewButton.
 * C13 FIX: Card field validation in enterReviewMode and presentCard.
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
  ratings: Record<string, number>;
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

const SESSION_MODE_TTL_MS = 4 * 60 * 60 * 1000;

// ─── Card Validation (C13 FIX) ──────────────────────────

/**
 * C13 FIX: Validate and sanitize flashcard items from RPC.
 * Filters out cards missing required fields to prevent runtime errors.
 */
function validateCards(rawCards: unknown[]): FlashcardItem[] {
  return rawCards
    .filter((card): card is Record<string, unknown> => {
      if (!card || typeof card !== "object") return false;
      const c = card as Record<string, unknown>;
      return !!c.id && typeof c.id === "string";
    })
    .map((c) => ({
      id: c.id as string,
      front_text: (c.front_text as string) || (c.keyword_name as string) || "[Sin contenido]",
      back_text: (c.back_text as string) || "[Sin respuesta]",
      keyword_name: (c.keyword_name as string) || undefined,
      course_name: (c.course_name as string) || undefined,
    }));
}

// ─── Enter Review Mode ──────────────────────────────────

export async function enterReviewMode(
  phoneHash: string,
  phone: string,
  userId: string,
  cards: FlashcardItem[],
  sessionVersion: number,
): Promise<boolean> {
  const db = getAdminClient();

  // C13 FIX: Validate cards before using
  const validCards = validateCards(cards as unknown[]);

  if (!validCards || validCards.length === 0) {
    await sendText(phone, "No tienes flashcards pendientes. \ud83c\udf89 ¡Estás al día!");
    return false;
  }

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
    await sendText(phone, "Error al iniciar la sesión. Intenta de nuevo. \ud83d\ude14");
    return false;
  }

  const reviewContext: ReviewSessionContext = {
    ghost_session_id: ghostSession.id,
    queue: validCards.slice(0, 50),
    cursor: 0,
    cards_reviewed: 0,
    ratings: { "1": 0, "3": 0, "4": 0 },
  };

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
    await sendText(phone, "Error al iniciar. Intenta de nuevo. \ud83d\ude14");
    return false;
  }

  await sendText(
    phone,
    `\ud83d\udcda Sesión de repaso: ${validCards.length} flashcards\n\n` +
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

  // C13 FIX: Defensive access with fallbacks
  const frontText = (card.front_text || "[Sin contenido]").slice(0, 800);
  const backText = (card.back_text || "[Sin respuesta]").slice(0, 600);

  const body =
    `\ud83d\udccb ${cardNum}/${total}${labelStr}\n\n` +
    `${frontText}\n\n` +
    `\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n` +
    `${backText}`;

  await sendInteractiveButtons(phone, body.slice(0, 1024), RATING_BUTTONS);
}

// ─── Handle Rating Button Press ─────────────────────────

export async function handleReviewButton(
  phoneHash: string,
  phone: string,
  userId: string,
  buttonPayload: string,
  currentContext: Record<string, unknown>,
  sessionVersion: number,
): Promise<boolean> {
  const db = getAdminClient();

  const ctx = currentContext as unknown as ReviewSessionContext;
  if (!ctx.ghost_session_id || !ctx.queue) {
    console.warn("[WA-ReviewFlow] Invalid review context, exiting mode");
    await exitReviewMode(phoneHash, phone, ctx, sessionVersion);
    return true;
  }

  const rating = BUTTON_TO_RATING[buttonPayload];
  if (!rating) {
    await sendText(phone, "Usá los botones Fail / Good / Easy para calificar. \ud83d\udc46");
    return true;
  }

  const currentCard = ctx.queue[ctx.cursor];
  if (!currentCard) {
    await exitReviewMode(phoneHash, phone, ctx, sessionVersion);
    return true;
  }

  try {
    await db.from("reviews").insert({
      session_id: ctx.ghost_session_id,
      item_id: currentCard.id,
      instrument_type: "flashcard",
      grade: rating,
    });
  } catch (e) {
    console.error(`[WA-ReviewFlow] Review insert failed: ${(e as Error).message}`);
  }

  ctx.cursor += 1;
  ctx.cards_reviewed += 1;
  ctx.ratings[String(rating)] = (ctx.ratings[String(rating)] || 0) + 1;

  if (ctx.cursor >= ctx.queue.length) {
    await exitReviewMode(phoneHash, phone, ctx, sessionVersion);
    return true;
  }

  // C8 FIX: Check optimistic lock error on session update
  const { error: saveErr } = await db
    .from("whatsapp_sessions")
    .update({
      current_context: ctx,
      version: sessionVersion + 1,
      expires_at: new Date(Date.now() + SESSION_MODE_TTL_MS).toISOString(),
    })
    .eq("phone_hash", phoneHash)
    .eq("version", sessionVersion);

  if (saveErr) {
    console.warn(
      `[WA-ReviewFlow] Context save failed: ${saveErr.message}. ` +
      `Cursor may desync — next button press will reload from DB.`,
    );
  }

  await presentCard(phone, ctx);
  return true;
}

// ─── Handle Exit ────────────────────────────────────────

export async function exitReviewMode(
  phoneHash: string,
  phone: string,
  context: ReviewSessionContext | Record<string, unknown>,
  sessionVersion: number,
): Promise<void> {
  const db = getAdminClient();
  const ctx = context as ReviewSessionContext;

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
      : `¡Excelente sesión! \ud83c\udf1f`),
  );
}

// ─── Check for Exit Command ─────────────────────────────

export function isExitCommand(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return [
    "salir", "exit", "terminar", "parar", "cancelar",
    "stop", "quit", "fin", "basta",
  ].includes(normalized);
}

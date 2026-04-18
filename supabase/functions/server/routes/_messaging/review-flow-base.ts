/**
 * routes/_messaging/review-flow-base.ts — Shared flashcard review state machine
 *
 * Deterministic Session Mode used by:
 *   - routes/telegram/review-flow.ts  (inline keyboard, chat_id)
 *   - routes/whatsapp/review-flow.ts  (interactive buttons, phone_hash)
 *
 * Both channels run the same review loop:
 *   enter -> present card -> handle rating -> advance -> (loop | exit)
 *
 * The differences between channels are entirely about addressing and UI
 * rendering. They are captured in the ReviewFlowAdapter interface, which
 * the channel wrappers construct per-request and pass to the shared
 * functions below.
 *
 * PUBLIC BEHAVIOR STABILITY: this module preserves exact DB schema
 * (study_sessions inserts, reviews inserts, session table updates
 * gated by optimistic lock) and exact messaging wording.
 */

import { getAdminClient } from "../../db.ts";

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

export interface RatingButton {
  id: string;
  title: string;
}

/** Public rating callback IDs (shared by both channels). */
export const RATING_BUTTON_DEFS: RatingButton[] = [
  { id: "review_fail", title: "\u274c Fail" },
  { id: "review_good", title: "\u2705 Good" },
  { id: "review_easy", title: "\ud83d\udca1 Easy" },
];

/** Maps a button/callback id to an FSRS grade. */
export const BUTTON_TO_RATING: Record<string, number> = {
  review_fail: 1,
  review_good: 3,
  review_easy: 4,
};

// ─── Constants ───────────────────────────────────────────

export const SESSION_MODE_TTL_MS = 4 * 60 * 60 * 1000;
const CARD_BODY_MAX = 4096;

// ─── Adapter ─────────────────────────────────────────────

/**
 * Channel adapter for a single review interaction. The channel wrapper
 * constructs one of these per-request with everything already bound
 * (send targets, session table coordinates, log prefix).
 */
export interface ReviewFlowAdapter {
  /** Short tag used for log lines, e.g. "TG-ReviewFlow" or "WA-ReviewFlow". */
  logPrefix: string;
  /** Value stored in study_sessions.session_type on ghost-session insert. */
  sessionType: string;
  /** Name of the per-channel sessions table, e.g. "telegram_sessions". */
  sessionTable: string;
  /** Name of the primary-key column on the sessions table. */
  sessionKeyField: string;
  /** Value of the sessions-table key to match. */
  sessionKeyValue: string | number;
  /** Max body length for a card presentation (TG=4096, WA=1024). */
  cardBodyMaxChars: number;
  /** Copy for the "how to exit" instruction in the session-entry message. */
  exitCommandHelp: string;
  /**
   * Copy shown when the user has no pending flashcards. The two channels
   * historically used slightly different emoji placement, so this is
   * adapter-provided to preserve byte-for-byte output.
   */
  emptyQueueMessage: string;
  /** Sends a plain text message to the caller. */
  sendText: (body: string) => Promise<void>;
  /** Sends a text body with an attached rating keypad. */
  sendCardWithButtons: (
    body: string,
    buttons: RatingButton[],
  ) => Promise<void>;
}

// ─── Card Validation ─────────────────────────────────────

/**
 * Validates and sanitizes flashcard items from RPC. Filters out cards
 * missing required fields to prevent runtime errors downstream.
 */
export function validateCards(rawCards: unknown[]): FlashcardItem[] {
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

/**
 * Creates a ghost study_sessions row, initializes the per-channel
 * review context, and sends the entry message + first card.
 * Returns true if the session entered review mode successfully.
 */
export async function enterReviewMode(
  adapter: ReviewFlowAdapter,
  userId: string,
  cards: FlashcardItem[],
  sessionVersion: number,
): Promise<boolean> {
  const db = getAdminClient();

  const validCards = validateCards(cards as unknown[]);
  if (!validCards || validCards.length === 0) {
    await adapter.sendText(adapter.emptyQueueMessage);
    return false;
  }

  const { data: ghostSession, error: sessionErr } = await db
    .from("study_sessions")
    .insert({
      student_id: userId,
      session_type: adapter.sessionType,
    })
    .select("id")
    .single();

  if (sessionErr || !ghostSession) {
    console.error(
      `[${adapter.logPrefix}] Ghost session creation failed: ${sessionErr?.message}`,
    );
    await adapter.sendText("Error al iniciar la sesión. Intenta de nuevo. \ud83d\ude14");
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
    .from(adapter.sessionTable)
    .update({
      mode: "flashcard_review",
      current_context: reviewContext,
      current_tool: "flashcard_review",
      version: sessionVersion + 1,
      expires_at: new Date(Date.now() + SESSION_MODE_TTL_MS).toISOString(),
    })
    .eq(adapter.sessionKeyField, adapter.sessionKeyValue)
    .eq("version", sessionVersion);

  if (updateErr) {
    console.error(
      `[${adapter.logPrefix}] Session update failed: ${updateErr.message}`,
    );
    await adapter.sendText("Error al iniciar. Intenta de nuevo. \ud83d\ude14");
    return false;
  }

  await adapter.sendText(
    `\ud83d\udcda Sesión de repaso: ${validCards.length} flashcards\n\n` +
    `Calificá cada tarjeta:\n` +
    `\u274c Fail = No la sabía\n` +
    `\u2705 Good = La sabía con esfuerzo\n` +
    `\ud83d\udca1 Easy = La sabía al instante\n\n` +
    `${adapter.exitCommandHelp}`,
  );

  await presentCard(adapter, reviewContext);
  return true;
}

// ─── Present Current Card ────────────────────────────────

async function presentCard(
  adapter: ReviewFlowAdapter,
  ctx: ReviewSessionContext,
): Promise<void> {
  const card = ctx.queue[ctx.cursor];
  if (!card) return;

  const cardNum = ctx.cursor + 1;
  const total = ctx.queue.length;
  const label = card.keyword_name || card.course_name || "";
  const labelStr = label ? ` (${label})` : "";

  const frontText = (card.front_text || "[Sin contenido]").slice(0, 800);
  const backText = (card.back_text || "[Sin respuesta]").slice(0, 600);

  const body =
    `\ud83d\udccb ${cardNum}/${total}${labelStr}\n\n` +
    `${frontText}\n\n` +
    `\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n` +
    `${backText}`;

  await adapter.sendCardWithButtons(
    body.slice(0, adapter.cardBodyMaxChars ?? CARD_BODY_MAX),
    RATING_BUTTON_DEFS,
  );
}

// ─── Handle Rating Input ─────────────────────────────────

/**
 * Called from the channel wrapper when the user presses a rating button
 * (or its text equivalent). Advances the cursor, persists the context,
 * and either presents the next card or exits review mode.
 */
export async function handleReviewInput(
  adapter: ReviewFlowAdapter,
  _userId: string,
  inputPayload: string,
  currentContext: Record<string, unknown>,
  sessionVersion: number,
): Promise<boolean> {
  const db = getAdminClient();

  const ctx = currentContext as unknown as ReviewSessionContext;
  if (!ctx.ghost_session_id || !ctx.queue) {
    console.warn(`[${adapter.logPrefix}] Invalid review context, exiting mode`);
    await exitReviewMode(adapter, ctx, sessionVersion);
    return true;
  }

  const rating = BUTTON_TO_RATING[inputPayload];
  if (!rating) {
    await adapter.sendText(
      "Usá los botones Fail / Good / Easy para calificar. \ud83d\udc46",
    );
    return true;
  }

  const currentCard = ctx.queue[ctx.cursor];
  if (!currentCard) {
    await exitReviewMode(adapter, ctx, sessionVersion);
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
    console.error(
      `[${adapter.logPrefix}] Review insert failed: ${(e as Error).message}`,
    );
  }

  ctx.cursor += 1;
  ctx.cards_reviewed += 1;
  ctx.ratings[String(rating)] = (ctx.ratings[String(rating)] || 0) + 1;

  if (ctx.cursor >= ctx.queue.length) {
    await exitReviewMode(adapter, ctx, sessionVersion);
    return true;
  }

  const { error: saveErr } = await db
    .from(adapter.sessionTable)
    .update({
      current_context: ctx,
      version: sessionVersion + 1,
      expires_at: new Date(Date.now() + SESSION_MODE_TTL_MS).toISOString(),
    })
    .eq(adapter.sessionKeyField, adapter.sessionKeyValue)
    .eq("version", sessionVersion);

  if (saveErr) {
    console.warn(
      `[${adapter.logPrefix}] Context save failed: ${saveErr.message}`,
    );
  }

  await presentCard(adapter, ctx);
  return true;
}

// ─── Handle Exit ─────────────────────────────────────────

export async function exitReviewMode(
  adapter: ReviewFlowAdapter,
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
      console.warn(
        `[${adapter.logPrefix}] Session stats update failed: ${(e as Error).message}`,
      );
    }
  }

  await db
    .from(adapter.sessionTable)
    .update({
      mode: "conversation",
      current_tool: null,
      current_context: {},
      version: sessionVersion + 1,
    })
    .eq(adapter.sessionKeyField, adapter.sessionKeyValue)
    .eq("version", sessionVersion);

  const reviewed = ctx.cards_reviewed || 0;
  const fail = ctx.ratings?.["1"] || 0;
  const good = ctx.ratings?.["3"] || 0;
  const easy = ctx.ratings?.["4"] || 0;
  const total = ctx.queue?.length || 0;

  if (reviewed === 0) {
    await adapter.sendText("Sesión de repaso cancelada. \ud83d\udc4b");
    return;
  }

  const accuracy = reviewed > 0 ? Math.round(((good + easy) / reviewed) * 100) : 0;

  await adapter.sendText(
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

// ─── Exit Command Detection ──────────────────────────────

const SHARED_EXIT_TOKENS = [
  "salir", "exit", "terminar", "parar", "cancelar",
  "stop", "quit", "fin", "basta",
];

/** Returns true if the text matches a known exit command for this channel. */
export function matchesExitToken(
  text: string,
  extraTokens: readonly string[] = [],
): boolean {
  const normalized = text.trim().toLowerCase();
  return SHARED_EXIT_TOKENS.includes(normalized) ||
    extraTokens.includes(normalized);
}

/**
 * routes/telegram/review-flow.ts — Flashcard review state machine for Telegram
 *
 * Thin wrapper over routes/_messaging/review-flow-base.ts.
 * Mirrors WhatsApp review-flow.ts but uses Telegram inline keyboard
 * buttons instead of WhatsApp interactive buttons.
 *
 * Deterministic Session Mode: bypasses Claude entirely for fast responses.
 *
 * PUBLIC API: enterReviewMode, handleReviewCallback, exitReviewMode,
 * isExitCommand, FlashcardItem. Imported by routes/telegram/handler.ts.
 */

import { sendTextPlain, sendWithInlineKeyboard } from "./tg-client.ts";
import type { InlineKeyboardButton } from "./tg-client.ts";
import {
  enterReviewMode as baseEnterReviewMode,
  handleReviewInput as baseHandleReviewInput,
  exitReviewMode as baseExitReviewMode,
  matchesExitToken,
  type FlashcardItem,
  type RatingButton,
  type ReviewFlowAdapter,
  type ReviewSessionContext,
} from "../_messaging/review-flow-base.ts";

export type { FlashcardItem, ReviewSessionContext };

// ─── Telegram-specific Adapter Builder ───────────────────

const TG_CARD_BODY_MAX = 4096;

function ratingButtonsToInlineKeyboard(
  buttons: RatingButton[],
): InlineKeyboardButton[][] {
  return [
    buttons.map((b) => ({ text: b.title, callback_data: b.id })),
  ];
}

function buildAdapter(chatId: number): ReviewFlowAdapter {
  return {
    logPrefix: "TG-ReviewFlow",
    sessionType: "telegram_review",
    sessionTable: "telegram_sessions",
    sessionKeyField: "chat_id",
    sessionKeyValue: chatId,
    cardBodyMaxChars: TG_CARD_BODY_MAX,
    exitCommandHelp: "Escribí /salir para terminar antes.",
    emptyQueueMessage: "\ud83c\udf89 No tienes flashcards pendientes. ¡Estás al día!",
    sendText: async (body) => {
      await sendTextPlain(chatId, body);
    },
    sendCardWithButtons: async (body, buttons) => {
      await sendWithInlineKeyboard(
        chatId,
        body,
        ratingButtonsToInlineKeyboard(buttons),
        "",
      );
    },
  };
}

// ─── Public API ──────────────────────────────────────────

export async function enterReviewMode(
  chatId: number,
  userId: string,
  cards: FlashcardItem[],
  sessionVersion: number,
): Promise<boolean> {
  return await baseEnterReviewMode(
    buildAdapter(chatId),
    userId,
    cards,
    sessionVersion,
  );
}

export async function handleReviewCallback(
  chatId: number,
  userId: string,
  callbackData: string,
  currentContext: Record<string, unknown>,
  sessionVersion: number,
): Promise<boolean> {
  return await baseHandleReviewInput(
    buildAdapter(chatId),
    userId,
    callbackData,
    currentContext,
    sessionVersion,
  );
}

export async function exitReviewMode(
  chatId: number,
  context: ReviewSessionContext | Record<string, unknown>,
  sessionVersion: number,
): Promise<void> {
  await baseExitReviewMode(buildAdapter(chatId), context, sessionVersion);
}

/**
 * Telegram supports slash-commands as exit tokens on top of the
 * shared keyword list (salir, exit, etc.).
 */
export function isExitCommand(text: string): boolean {
  return matchesExitToken(text, ["/salir", "/exit", "/stop"]);
}

/**
 * routes/whatsapp/review-flow.ts — Flashcard review state machine (S10)
 *
 * Thin wrapper over routes/_messaging/review-flow-base.ts.
 * Deterministic Session Mode: bypasses Gemini entirely for ~200ms responses.
 *
 * C8 FIX: Optimistic lock errors are checked inside the shared base.
 * C13 FIX: Card field validation lives in validateCards() in the base.
 *
 * PUBLIC API: enterReviewMode, handleReviewButton, exitReviewMode,
 * isExitCommand, FlashcardItem. Imported by routes/whatsapp/handler.ts.
 */

import { sendText, sendInteractiveButtons } from "./wa-client.ts";
import type { ButtonDef } from "./wa-client.ts";
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

// ─── WhatsApp-specific Adapter Builder ───────────────────

const WA_CARD_BODY_MAX = 1024;

function ratingButtonsToWaButtons(buttons: RatingButton[]): ButtonDef[] {
  return buttons.map((b) => ({ id: b.id, title: b.title }));
}

function buildAdapter(phoneHash: string, phone: string): ReviewFlowAdapter {
  return {
    logPrefix: "WA-ReviewFlow",
    sessionType: "whatsapp_review",
    sessionTable: "whatsapp_sessions",
    sessionKeyField: "phone_hash",
    sessionKeyValue: phoneHash,
    cardBodyMaxChars: WA_CARD_BODY_MAX,
    exitCommandHelp: 'Escribí "salir" para terminar antes.',
    emptyQueueMessage: "No tienes flashcards pendientes. \ud83c\udf89 ¡Estás al día!",
    sendText: async (body) => {
      await sendText(phone, body);
    },
    sendCardWithButtons: async (body, buttons) => {
      await sendInteractiveButtons(
        phone,
        body,
        ratingButtonsToWaButtons(buttons),
      );
    },
  };
}

// ─── Public API ──────────────────────────────────────────

export async function enterReviewMode(
  phoneHash: string,
  phone: string,
  userId: string,
  cards: FlashcardItem[],
  sessionVersion: number,
): Promise<boolean> {
  return await baseEnterReviewMode(
    buildAdapter(phoneHash, phone),
    userId,
    cards,
    sessionVersion,
  );
}

export async function handleReviewButton(
  phoneHash: string,
  phone: string,
  userId: string,
  buttonPayload: string,
  currentContext: Record<string, unknown>,
  sessionVersion: number,
): Promise<boolean> {
  return await baseHandleReviewInput(
    buildAdapter(phoneHash, phone),
    userId,
    buttonPayload,
    currentContext,
    sessionVersion,
  );
}

export async function exitReviewMode(
  phoneHash: string,
  phone: string,
  context: ReviewSessionContext | Record<string, unknown>,
  sessionVersion: number,
): Promise<void> {
  await baseExitReviewMode(
    buildAdapter(phoneHash, phone),
    context,
    sessionVersion,
  );
}

/**
 * WhatsApp does not use slash-commands, so only the shared keyword
 * list is recognized as an exit token.
 */
export function isExitCommand(text: string): boolean {
  return matchesExitToken(text);
}

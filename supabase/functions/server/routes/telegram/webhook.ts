/**
 * routes/telegram/webhook.ts — Telegram Bot API webhook handler
 *
 * POST /webhooks/telegram — Incoming messages + callback queries
 * POST /telegram/set-webhook — Admin endpoint to configure webhook URL
 *
 * Security:
 *   - Webhook secret token verification (X-Telegram-Bot-Api-Secret-Token)
 *   - Deduplication by Telegram message ID
 *   - Per-chat rate limiting
 */

import type { Context } from "npm:hono";
import { err, getAdminClient, ok } from "../../db.ts";
import { sendTextPlain, answerCallbackQuery } from "./tg-client.ts";
import { handleMessage } from "./handler.ts";
import { verifyLinkCode, isLinkingCode } from "./link.ts";
import { checkTelegramRateLimit, sendRateLimitMessage } from "./tg-rate-limit.ts";
import { timingSafeEqual } from "../../timing-safe.ts";

// ─── Types ───────────────────────────────────────────────

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: {
      id: number;
      is_bot: boolean;
      first_name: string;
      username?: string;
    };
    chat: {
      id: number;
      type: string;
      first_name?: string;
      username?: string;
    };
    date: number;
    text?: string;
    voice?: {
      file_id: string;
      file_unique_id: string;
      duration: number;
      mime_type?: string;
    };
  };
  callback_query?: {
    id: string;
    from: {
      id: number;
      is_bot: boolean;
      first_name: string;
      username?: string;
    };
    message?: {
      message_id: number;
      chat: { id: number };
    };
    data?: string;
  };
}

// ─── Deduplication ───────────────────────────────────────

async function isDuplicate(chatId: number, tgMessageId: number): Promise<boolean> {
  const admin = getAdminClient();
  const { data } = await admin
    .from("telegram_message_log")
    .select("id")
    .eq("tg_message_id", tgMessageId)
    .eq("chat_id", chatId)
    .limit(1);
  return (data?.length ?? 0) > 0;
}

async function insertLogRecord(
  chatId: number,
  tgMessageId: number,
  userId: string | null,
  messageType: string,
): Promise<void> {
  const admin = getAdminClient();
  try {
    await admin.from("telegram_message_log").insert({
      chat_id: chatId,
      tg_message_id: tgMessageId,
      user_id: userId,
      direction: "in",
      message_type: messageType,
      success: true,
    });
  } catch (e) {
    console.warn(`[TG-Webhook] Log insert failed: ${(e as Error).message}`);
  }
}

// ─── User Lookup ─────────────────────────────────────────

async function lookupLinkedUser(
  chatId: number,
): Promise<{ userId: string } | null> {
  const admin = getAdminClient();

  const { data } = await admin
    .from("telegram_links")
    .select("user_id")
    .eq("chat_id", chatId)
    .eq("is_active", true)
    .single();

  if (data) {
    return { userId: data.user_id };
  }

  return null;
}

// ─── Webhook Secret Verification ─────────────────────────

function verifyWebhookSecret(c: Context): boolean {
  const secret = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");
  if (!secret) {
    console.error("[TG-Webhook] CRITICAL: TELEGRAM_WEBHOOK_SECRET not configured — rejecting all webhooks");
    return false;
  }

  const headerSecret = c.req.header("X-Telegram-Bot-Api-Secret-Token");
  if (!headerSecret) return false;
  return timingSafeEqual(headerSecret, secret);
}

// ─── Command Handler ─────────────────────────────────────

function isCommand(text: string): boolean {
  return text.startsWith("/");
}

async function handleCommand(
  chatId: number,
  text: string,
  username?: string,
): Promise<boolean> {
  const command = text.split(" ")[0].toLowerCase().replace(/@\w+$/, "");

  switch (command) {
    case "/start":
      await sendTextPlain(
        chatId,
        "\ud83d\udc4b ¡Hola! Soy *Axon*, tu asistente de estudio.\n\n" +
        "Para empezar, vinculá tu cuenta:\n" +
        "1\ufe0f\u20e3 Abrí axon.app/settings\n" +
        "2\ufe0f\u20e3 Tocá \"Vincular Telegram\"\n" +
        "3\ufe0f\u20e3 Envíame el código de 6 dígitos acá\n\n" +
        "Una vez vinculado, podés:\n" +
        "\u2022 Preguntar qué estudiar hoy\n" +
        "\u2022 Ver tu agenda y actualizarla\n" +
        "\u2022 Repasar flashcards\n" +
        "\u2022 Hacer preguntas académicas\n" +
        "\u2022 Ver palabras clave y resúmenes\n" +
        "\u2022 Generar material de estudio\n\n" +
        "Todo potenciado por Claude AI \ud83e\udde0",
      );
      return true;

    case "/help":
    case "/ayuda":
      await sendTextPlain(
        chatId,
        "\ud83d\udcda *Comandos disponibles:*\n\n" +
        "/start — Información inicial\n" +
        "/agenda — Ver tu agenda de hoy\n" +
        "/semana — Ver tu agenda de la semana\n" +
        "/estudiar — Iniciar sesión de flashcards\n" +
        "/progreso — Ver tu progreso\n" +
        "/cursos — Ver tus cursos\n" +
        "/salir — Terminar sesión de flashcards\n" +
        "/help — Ver esta ayuda\n\n" +
        "También podés escribirme en lenguaje natural \ud83d\ude0a",
      );
      return true;

    case "/agenda":
      return false; // Let the AI handler process it with get_schedule tool

    case "/semana":
      return false;

    case "/estudiar":
      return false;

    case "/progreso":
      return false;

    case "/cursos":
      return false;

    default:
      return false; // Unknown command, pass to AI
  }
}

// ─── Main Webhook Handler ────────────────────────────────

export async function handleIncomingUpdate(c: Context): Promise<Response> {
  const startMs = Date.now();

  // ── Verify webhook secret ──
  if (!verifyWebhookSecret(c)) {
    console.warn("[TG-Webhook] Invalid webhook secret");
    return err(c, "Invalid secret", 401);
  }

  // ── Parse update ──
  let update: TelegramUpdate;
  try {
    update = await c.req.json();
  } catch {
    return err(c, "Invalid JSON", 400);
  }

  // ── Handle callback queries (inline keyboard buttons) ──
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message?.chat?.id;
    const callbackData = cb.data;

    if (chatId && callbackData) {
      const linked = await lookupLinkedUser(chatId);

      if (linked) {
        try {
          await handleMessage({
            chatId,
            userId: linked.userId,
            messageId: cb.message?.message_id ?? 0,
            messageType: "callback",
            callbackData,
            callbackQueryId: cb.id,
          });
        } catch (e) {
          console.error(`[TG-Webhook] Callback error: ${(e as Error).message}`);
        }
      }

      // Always answer callback to remove loading state
      await answerCallbackQuery(cb.id);
    }

    return c.text("OK", 200);
  }

  // ── Handle messages ──
  const message = update.message;
  if (!message) {
    return c.text("OK", 200);
  }

  const chatId = message.chat.id;
  const tgMessageId = message.message_id;
  const fromUser = message.from;
  const chatType = message.chat.type;
  const username = fromUser?.username;

  // Only handle private chats
  if (chatType !== "private") {
    return c.text("OK", 200);
  }

  // ── Dedup check ──
  try {
    if (await isDuplicate(chatId, tgMessageId)) {
      console.warn(`[TG-Webhook] Duplicate ${tgMessageId}, ignoring`);
      return c.text("OK", 200);
    }
  } catch (e) {
    console.warn(`[TG-Webhook] Dedup check failed: ${(e as Error).message}`);
  }

  // ── Determine message type and content ──
  let messageType: "text" | "voice" | "command" = "text";
  let textContent = message.text ?? "";
  let voiceFileId: string | undefined;

  if (message.voice) {
    messageType = "voice";
    voiceFileId = message.voice.file_id;
  } else if (textContent && isCommand(textContent)) {
    messageType = "command";
  }

  console.warn(
    `[TG-Webhook] ${fromUser?.first_name ?? "?"} (@${username ?? "?"}): ` +
    `type=${messageType}, text="${textContent.slice(0, 80)}"`,
  );

  // ── Route message ──
  try {
    const linked = await lookupLinkedUser(chatId);

    // Rate limiting
    const rateLimitResult = checkTelegramRateLimit(chatId, !!linked);
    if (rateLimitResult !== "allowed") {
      console.warn(`[TG-Webhook] Rate limited (${rateLimitResult}): chat ${chatId}`);
      await insertLogRecord(chatId, tgMessageId, linked?.userId ?? null, messageType);
      if (rateLimitResult === "first_block") {
        await sendRateLimitMessage(chatId);
      }
      return c.text("OK", 200);
    }

    if (linked) {
      await insertLogRecord(chatId, tgMessageId, linked.userId, messageType);

      // Handle commands that return immediately
      if (messageType === "command" && textContent) {
        const handled = await handleCommand(chatId, textContent, username);
        if (handled) {
          return c.text("OK", 200);
        }
        // Commands not handled above → translate to natural language for the AI
        const commandMap: Record<string, string> = {
          "/agenda": "Mostrá mi agenda de hoy",
          "/semana": "Mostrá mi agenda de la semana",
          "/estudiar": "Qué debo estudiar? Quiero repasar flashcards",
          "/progreso": "Cómo va mi progreso?",
          "/cursos": "Mostrá mis cursos",
        };
        const cmd = textContent.split(" ")[0].toLowerCase().replace(/@\w+$/, "");
        textContent = commandMap[cmd] || textContent;
      }

      await handleMessage({
        chatId,
        userId: linked.userId,
        messageId: tgMessageId,
        messageType: messageType === "command" ? "text" : messageType,
        text: textContent || undefined,
        voiceFileId,
      });
    } else {
      await insertLogRecord(chatId, tgMessageId, null, messageType);

      // Not linked — check for linking code or show instructions
      if (textContent && isLinkingCode(textContent)) {
        const result = await verifyLinkCode(chatId, username, textContent.trim());
        if (result.success) {
          await sendTextPlain(
            chatId,
            "\u00a1Vinculado! Ya podés estudiar por Telegram \ud83c\udf89\n\n" +
            "Probá enviando:\n" +
            "\u2022 \"Qué debo estudiar?\"\n" +
            "\u2022 \"Mostrá mi agenda\"\n" +
            "\u2022 \"Palabras clave de [curso]\"\n" +
            "\u2022 O cualquier pregunta académica",
          );
        } else {
          await sendTextPlain(
            chatId,
            "Código inválido o expirado. \u274c\n\n" +
            "Generá uno nuevo desde la app en Configuración > Telegram.",
          );
        }
      } else if (textContent && isCommand(textContent)) {
        await handleCommand(chatId, textContent, username);
      } else {
        await sendTextPlain(
          chatId,
          "\ud83d\udc4b ¡Hola! Soy Axon, tu asistente de estudio.\n\n" +
          "Para empezar, vinculá tu cuenta:\n" +
          "1\ufe0f\u20e3 Abrí axon.app/settings\n" +
          "2\ufe0f\u20e3 Tocá \"Vincular Telegram\"\n" +
          "3\ufe0f\u20e3 Envíame el código de 6 dígitos acá\n\n" +
          "¡Listo! Después podés preguntarme cualquier cosa.",
        );
      }
    }
  } catch (e) {
    console.error(`[TG-Webhook] Processing error: ${(e as Error).message}`);
    try {
      await sendTextPlain(chatId, "Algo salió mal. Intenta de nuevo. \ud83d\ude14");
    } catch { /* can't send error message */ }
  }

  const latencyMs = Date.now() - startMs;
  console.warn(`[TG-Webhook] Completed in ${latencyMs}ms`);

  return c.text("OK", 200);
}

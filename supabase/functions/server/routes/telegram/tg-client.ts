/**
 * routes/telegram/tg-client.ts — Telegram Bot API client
 *
 * Typed wrapper around Telegram Bot API for sending messages.
 * All send* functions log errors but never throw (fire-and-forget safe).
 *
 * @see https://core.telegram.org/bots/api
 */

// ─── Config ──────────────────────────────────────────────

const TG_BASE_URL = "https://api.telegram.org";
const DEFAULT_TIMEOUT_MS = 10_000;

function getBotToken(): string {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!token) throw new Error("[TG-Client] TELEGRAM_BOT_TOKEN not configured");
  return token;
}

function getApiUrl(method: string): string {
  return `${TG_BASE_URL}/bot${getBotToken()}/${method}`;
}

// ─── Fetch with Timeout ──────────────────────────────────

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// ─── Types ───────────────────────────────────────────────

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

// ─── Internal Send Helper ────────────────────────────────

async function callTelegramApi(
  method: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const url = getApiUrl(method);

  try {
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.error(`[TG-Client] ${method} failed (${res.status}): ${errBody}`);
      return null;
    }

    const data = await res.json();
    return data.result ?? null;
  } catch (e) {
    console.error(`[TG-Client] ${method} error: ${(e as Error).message}`);
    return null;
  }
}

// ─── Public API ──────────────────────────────────────────

export async function sendText(
  chatId: number | string,
  text: string,
  parseMode: "Markdown" | "HTML" | "" = "Markdown",
): Promise<void> {
  await callTelegramApi("sendMessage", {
    chat_id: chatId,
    text: text.slice(0, 4096),
    ...(parseMode && { parse_mode: parseMode }),
  });
}

export async function sendTextPlain(
  chatId: number | string,
  text: string,
): Promise<void> {
  await callTelegramApi("sendMessage", {
    chat_id: chatId,
    text: text.slice(0, 4096),
  });
}

export async function sendWithInlineKeyboard(
  chatId: number | string,
  text: string,
  buttons: InlineKeyboardButton[][],
  parseMode: "Markdown" | "HTML" | "" = "Markdown",
): Promise<void> {
  await callTelegramApi("sendMessage", {
    chat_id: chatId,
    text: text.slice(0, 4096),
    ...(parseMode && { parse_mode: parseMode }),
    reply_markup: { inline_keyboard: buttons },
  });
}

export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  await callTelegramApi("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text && { text: text.slice(0, 200) }),
  });
}

export async function sendChatAction(
  chatId: number | string,
  action: "typing" | "upload_voice" | "upload_document" = "typing",
): Promise<void> {
  await callTelegramApi("sendChatAction", {
    chat_id: chatId,
    action,
  });
}

export async function setWebhook(url: string): Promise<boolean> {
  const secret = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");
  const result = await callTelegramApi("setWebhook", {
    url,
    allowed_updates: ["message", "callback_query"],
    max_connections: 40,
    ...(secret ? { secret_token: secret } : {}),
  });
  return !!result;
}

export async function deleteWebhook(): Promise<boolean> {
  const result = await callTelegramApi("deleteWebhook", {});
  return !!result;
}

export async function getMe(): Promise<Record<string, unknown> | null> {
  return await callTelegramApi("getMe", {});
}

/**
 * Download a file from Telegram (for voice messages).
 * Returns the file bytes and MIME type.
 */
export async function downloadFile(
  fileId: string,
): Promise<{ buffer: ArrayBuffer; mimeType: string }> {
  const token = getBotToken();

  // Step 1: Get file path
  const fileInfo = await callTelegramApi("getFile", { file_id: fileId });
  if (!fileInfo) {
    throw new Error(`[TG-Client] Failed to get file info for ${fileId}`);
  }

  const filePath = (fileInfo as { file_path?: string }).file_path;
  if (!filePath) {
    throw new Error(`[TG-Client] No file_path in response for ${fileId}`);
  }

  // Step 2: Download file
  const downloadUrl = `${TG_BASE_URL}/file/bot${token}/${filePath}`;
  const res = await fetchWithTimeout(downloadUrl, {}, 30_000);

  if (!res.ok) {
    throw new Error(`[TG-Client] File download failed (${res.status})`);
  }

  const mimeType = filePath.endsWith(".oga") || filePath.endsWith(".ogg")
    ? "audio/ogg"
    : filePath.endsWith(".mp3")
    ? "audio/mpeg"
    : "audio/ogg";

  return {
    buffer: await res.arrayBuffer(),
    mimeType,
  };
}

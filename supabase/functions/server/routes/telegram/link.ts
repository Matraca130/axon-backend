/**
 * routes/telegram/link.ts — Telegram account linking flow
 *
 * Simpler than WhatsApp linking since Telegram provides stable chat_id
 * and username. No phone hashing needed.
 *
 * Flow:
 *   1. Web UI: POST /telegram/link-code → generates 6-digit code
 *   2. Telegram: User sends code to bot
 *   3. Bot: verifyLinkCode() → creates telegram_links row
 */

import type { Context } from "npm:hono";
import { authenticate, ok, err, getAdminClient } from "../../db.ts";
import { sendTextPlain } from "./tg-client.ts";

// ─── Constants ───────────────────────────────────────────

const CODE_EXPIRY_SECONDS = 300; // 5 minutes

// ─── Code Generation ─────────────────────────────────────

function generateCode(): string {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  const code = 100_000 + (array[0] % 900_000);
  return code.toString();
}

// ─── Web Endpoint: Generate Link Code ────────────────────

export async function generateLinkCode(c: Context): Promise<Response> {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user } = auth;
  const db = getAdminClient();

  const { data: existingLink } = await db
    .from("telegram_links")
    .select("id, is_active")
    .eq("user_id", user.id)
    .eq("is_active", true)
    .single();

  if (existingLink) {
    return err(c, "Ya tenés Telegram vinculado. Desvinculá primero para vincular otro.", 409);
  }

  const code = generateCode();
  const expiresAt = new Date(Date.now() + CODE_EXPIRY_SECONDS * 1000).toISOString();

  // Store the linking code in a temporary telegram_session
  const linkingChatId = -Math.abs(hashCode(user.id)); // Temporary negative chat_id

  const { error } = await db
    .from("telegram_sessions")
    .upsert(
      {
        chat_id: linkingChatId,
        user_id: user.id,
        mode: "linking",
        current_context: {
          linking_code: code,
          linking_user_id: user.id,
          linking_expires_at: expiresAt,
        },
        expires_at: expiresAt,
        version: 0,
        history: [],
      },
      { onConflict: "chat_id" },
    );

  if (error) {
    console.error(`[TG-Link] Code generation failed: ${error.message}`);
    return err(c, "Error al generar código. Intentá de nuevo.", 500);
  }

  console.warn(`[TG-Link] Code ****${code.slice(-2)} generated for user ${user.id}`);

  return ok(c, {
    code,
    expiresIn: CODE_EXPIRY_SECONDS,
    instructions: "Enviá este código al bot de Axon en Telegram para vincular tu cuenta.",
    botUrl: getBotUrl(),
  });
}

// ─── Bot-side: Verify Link Code ──────────────────────────

export async function verifyLinkCode(
  chatId: number,
  username: string | undefined,
  code: string,
): Promise<{ success: boolean; userId?: string }> {
  const db = getAdminClient();

  const { data: sessions, error: searchError } = await db
    .from("telegram_sessions")
    .select("chat_id, current_context, expires_at")
    .eq("mode", "linking")
    .limit(200);

  if (searchError || !sessions) {
    console.error(`[TG-Link] Code search failed: ${searchError?.message}`);
    return { success: false };
  }

  const now = new Date();
  const matchingSession = sessions.find((s) => {
    const ctx = s.current_context as Record<string, unknown>;
    return (
      ctx.linking_code === code &&
      new Date(ctx.linking_expires_at as string) > now
    );
  });

  if (!matchingSession) {
    return { success: false };
  }

  const ctx = matchingSession.current_context as Record<string, unknown>;
  const userId = ctx.linking_user_id as string;

  // Create the link
  const { error: linkError } = await db
    .from("telegram_links")
    .insert({
      user_id: userId,
      chat_id: chatId,
      username: username || null,
      is_active: true,
    });

  if (linkError) {
    console.error(`[TG-Link] Link creation failed: ${linkError.message}`);
    return { success: false };
  }

  // Create a real session for this chat
  await db
    .from("telegram_sessions")
    .upsert(
      {
        chat_id: chatId,
        user_id: userId,
        mode: "conversation",
        current_context: {},
        version: 0,
        history: [],
      },
      { onConflict: "chat_id" },
    );

  // Clean up the temporary linking session
  await db
    .from("telegram_sessions")
    .delete()
    .eq("chat_id", matchingSession.chat_id);

  console.warn(`[TG-Link] Telegram linked for user ${userId}. Chat: ${chatId}`);

  return { success: true, userId };
}

export function isLinkingCode(text: string): boolean {
  return /^\d{6}$/.test(text.trim());
}

// ─── Link Status ────────────────────────────────────────

export async function getLinkStatus(c: Context): Promise<Response> {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user } = auth;
  const db = getAdminClient();

  const { data: link } = await db
    .from("telegram_links")
    .select("username, created_at")
    .eq("user_id", user.id)
    .eq("is_active", true)
    .single();

  if (link) {
    return ok(c, { is_linked: true, username: link.username, linked_at: link.created_at });
  }
  return ok(c, { is_linked: false });
}

// ─── Unlink Telegram ─────────────────────────────────────

export async function unlinkTelegram(c: Context): Promise<Response> {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user } = auth;
  const db = getAdminClient();

  const { error } = await db
    .from("telegram_links")
    .update({ is_active: false })
    .eq("user_id", user.id);

  if (error) {
    return err(c, "Error al desvincular. Intentá de nuevo.", 500);
  }

  return ok(c, { message: "Telegram desvinculado exitosamente." });
}

// ─── Helpers ─────────────────────────────────────────────

function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return hash;
}

function getBotUrl(): string {
  const username = Deno.env.get("TELEGRAM_BOT_USERNAME") || "AxonStudyBot";
  return `https://t.me/${username}`;
}

/**
 * routes/telegram/link.ts — Telegram account linking flow
 *
 * Simpler than WhatsApp linking since Telegram provides stable chat_id
 * and username. No phone hashing needed.
 *
 * Flow:
 *   1. Web UI: POST /telegram/link-code → generates 10-digit code
 *   2. Telegram: User sends code to bot
 *   3. Bot: verifyLinkCode() → creates telegram_links row
 */

import type { Context } from "npm:hono";
import { authenticate, ok, err, getAdminClient } from "../../db.ts";
import { sendTextPlain } from "./tg-client.ts";
import { createLinkingAttemptsTracker } from "../_messaging/linking-attempts.ts";
import { generateLinkingCode, isLinkingCode as sharedIsLinkingCode } from "../_messaging/linking-code.ts";

// ─── Constants ───────────────────────────────────────────

const CODE_EXPIRY_SECONDS = 300; // 5 minutes

// SEC-AUDIT FIX: lock a chat out after 5 failed linking attempts per hour
// as defense-in-depth on top of the entropy bump.
const attempts = createLinkingAttemptsTracker("TG-Link");

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
    return err(c, "Ya tienes Telegram vinculado. Desvincula primero para vincular otro.", 409);
  }

  const code = generateLinkingCode();
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
    return err(c, "Error al generar código. Intenta de nuevo.", 500);
  }

  console.warn(`[TG-Link] Code ****${code.slice(-2)} generated for user ${user.id}`);

  return ok(c, {
    code,
    expiresIn: CODE_EXPIRY_SECONDS,
    instructions: "Envía este código al bot de Axon en Telegram para vincular tu cuenta.",
    botUrl: getBotUrl(),
  });
}

// ─── Bot-side: Verify Link Code ──────────────────────────

export async function verifyLinkCode(
  chatId: number,
  username: string | undefined,
  code: string,
): Promise<{ success: boolean; userId?: string; lockedOut?: boolean }> {
  const attemptKey = `tg:${chatId}`;

  // SEC-AUDIT FIX: lock out chat after 5 failed attempts per hour.
  if (!attempts.allow(attemptKey)) {
    console.warn(`[TG-Link] Chat ${chatId} locked out (too many failed attempts)`);
    return { success: false, lockedOut: true };
  }

  const db = getAdminClient();

  // DB-side JSONB filter on current_context->linking_code instead of
  // loading up to 200 rows and filtering in JS. Fixes silent truncation
  // past the 200-row cap and avoids the full table scan on every /link
  // Telegram message. (#264)
  const nowIso = new Date().toISOString();
  const { data: matchingSession, error: searchError } = await db
    .from("telegram_sessions")
    .select("chat_id, current_context, expires_at")
    .eq("mode", "linking")
    .eq("current_context->>linking_code", code)
    .gt("current_context->>linking_expires_at", nowIso)
    .maybeSingle();

  if (searchError) {
    console.error(`[TG-Link] Code search failed: ${searchError.message}`);
    return { success: false };
  }

  if (!matchingSession) {
    attempts.recordFailure(attemptKey);
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

  attempts.reset(attemptKey);
  console.warn(`[TG-Link] Telegram linked for user ${userId}. Chat: ${chatId}`);

  return { success: true, userId };
}

export const isLinkingCode = sharedIsLinkingCode;

// ─── Link Status ────────────────────────────────────────

export async function getLinkStatus(c: Context): Promise<Response> {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user } = auth;
  const db = getAdminClient();

  const { data: link, error } = await db
    .from("telegram_links")
    .select("username, linked_at")
    .eq("user_id", user.id)
    .eq("is_active", true)
    .single();

  // PGRST116 = no rows found (not an error, just unlinked)
  if (error && error.code !== "PGRST116") {
    return err(c, "Error checking Telegram link status", 500);
  }

  if (link) {
    return ok(c, { is_linked: true, username: link.username, linked_at: link.linked_at });
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
    return err(c, "Error al desvincular. Intenta de nuevo.", 500);
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

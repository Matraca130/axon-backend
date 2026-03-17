/**
 * routes/telegram/tg-rate-limit.ts — Telegram-specific rate limiting
 *
 * Mirrors wa-rate-limit.ts pattern for Telegram.
 * Uses chat_id as the rate limit key (simpler than WhatsApp phone hashing).
 *
 * Limits:
 *   - Linked users:   30 messages per minute
 *   - Unlinked users:  10 messages per minute
 */

import { sendTextPlain } from "./tg-client.ts";

// ─── Configuration ───────────────────────────────────────

const WINDOW_MS = 60_000;
const LINKED_LIMIT = 30;
const UNLINKED_LIMIT = 10;
const CLEANUP_INTERVAL_MS = 5 * 60_000;

// ─── Types ───────────────────────────────────────────────

export type RateLimitResult = "allowed" | "first_block" | "silent_block";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// ─── State ───────────────────────────────────────────────

const chatLimitMap = new Map<string, RateLimitEntry>();
let lastCleanup = Date.now();

// ─── Core ────────────────────────────────────────────────

export function checkTelegramRateLimit(
  chatId: string | number,
  isLinked: boolean,
): RateLimitResult {
  const now = Date.now();
  const limit = isLinked ? LINKED_LIMIT : UNLINKED_LIMIT;
  const key = String(chatId);

  if (now - lastCleanup > CLEANUP_INTERVAL_MS) {
    cleanupExpired(now);
  }

  const entry = chatLimitMap.get(key);

  if (!entry || now > entry.resetAt) {
    chatLimitMap.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return "allowed";
  }

  entry.count++;

  if (entry.count === limit + 1) return "first_block";
  if (entry.count > limit + 1) return "silent_block";

  return "allowed";
}

export async function sendRateLimitMessage(chatId: number | string): Promise<void> {
  try {
    await sendTextPlain(
      chatId,
      "\u23f3 Demasiados mensajes. Esperá un minuto antes de enviar otro. \ud83d\ude4f",
    );
  } catch { /* best-effort */ }
}

// ─── Cleanup ─────────────────────────────────────────────

function cleanupExpired(now: number): void {
  let cleaned = 0;
  for (const [key, entry] of chatLimitMap) {
    if (now > entry.resetAt) {
      chatLimitMap.delete(key);
      cleaned++;
    }
  }
  lastCleanup = now;
  if (cleaned > 0) {
    console.log(`[TG-RateLimit] Cleaned ${cleaned} expired entries`);
  }
}

/**
 * routes/telegram/tg-rate-limit.ts — Telegram-specific rate limiting
 *
 * Thin wrapper over routes/_messaging/rate-limit-base.ts.
 * Uses chat_id as the rate limit key (simpler than WhatsApp phone hashing).
 *
 * Limits:
 *   - Linked users:   30 messages per minute
 *   - Unlinked users:  10 messages per minute
 */

import { sendTextPlain } from "./tg-client.ts";
import {
  createRateLimiter,
  type RateLimitResult,
} from "../_messaging/rate-limit-base.ts";

export type { RateLimitResult };

const limiter = createRateLimiter({
  logLabel: "TG-RateLimit",
  sendNotification: async (target, message) => {
    await sendTextPlain(target as number | string, message);
  },
});

export function checkTelegramRateLimit(
  chatId: string | number,
  isLinked: boolean,
): RateLimitResult {
  return limiter.check(String(chatId), isLinked);
}

export async function sendRateLimitMessage(chatId: number | string): Promise<void> {
  await limiter.sendRateLimitMessage(chatId);
}

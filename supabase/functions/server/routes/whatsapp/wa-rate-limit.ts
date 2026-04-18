/**
 * routes/whatsapp/wa-rate-limit.ts — WhatsApp-specific rate limiting (S12)
 *
 * Thin wrapper over routes/_messaging/rate-limit-base.ts.
 *
 * Separate from rate-limit.ts (Hono middleware, JWT-based) because:
 *   - Webhook requests have NO JWT (authenticated via HMAC)
 *   - We rate-limit by phone hash, not by user ID
 *   - Different limits for linked vs unlinked users
 *   - Must work before phone lookup (uses raw phone for unlinked)
 *
 * Limits:
 *   - Linked users:   30 messages per minute (normal usage)
 *   - Unlinked users:  10 messages per minute (anti-spam for strangers)
 *
 * C4 FIX: Returns block type ('allowed'|'first_block'|'silent_block')
 * so webhook.ts only sends rate-limit message on first_block.
 */

import { sendText } from "./wa-client.ts";
import {
  createRateLimiter,
  type RateLimitResult,
} from "../_messaging/rate-limit-base.ts";

export type { RateLimitResult };

const limiter = createRateLimiter({
  logLabel: "WA-RateLimit",
  sendNotification: async (target, message) => {
    await sendText(String(target), message);
  },
});

/**
 * Check if a phone number has exceeded its rate limit.
 *
 * C4 FIX: Returns a typed result instead of boolean:
 *   - 'allowed': request can proceed
 *   - 'first_block': first time exceeding limit (send rate-limit message)
 *   - 'silent_block': already notified, silently drop
 *
 * @param phoneKey - Phone hash (NEVER raw phone — see C6 FIX)
 * @param isLinked - Whether the user is linked (affects limit)
 */
export function checkWhatsAppRateLimit(
  phoneKey: string,
  isLinked: boolean,
): RateLimitResult {
  return limiter.check(phoneKey, isLinked);
}

/**
 * Send a rate-limit notification to the user.
 * Fire-and-forget; errors are logged but don't propagate.
 */
export async function sendRateLimitMessage(phone: string): Promise<void> {
  await limiter.sendRateLimitMessage(phone);
}

/** Returns the current map size (for health checks/diagnostics). */
export function getRateLimitMapSize(): number {
  return limiter.getMapSize();
}

/**
 * routes/whatsapp/wa-rate-limit.ts — WhatsApp-specific rate limiting (S12)
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

// ─── Configuration ───────────────────────────────────────

const WINDOW_MS = 60_000; // 1 minute
const LINKED_LIMIT = 30;
const UNLINKED_LIMIT = 10;
const CLEANUP_INTERVAL_MS = 5 * 60_000;

// ─── Types ──────────────────────────────────────────────

export type RateLimitResult = "allowed" | "first_block" | "silent_block";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// ─── State ──────────────────────────────────────────────

const phoneLimitMap = new Map<string, RateLimitEntry>();
let lastCleanup = Date.now();

// ─── Core ───────────────────────────────────────────────

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
  const now = Date.now();
  const limit = isLinked ? LINKED_LIMIT : UNLINKED_LIMIT;

  // Periodic cleanup
  if (now - lastCleanup > CLEANUP_INTERVAL_MS) {
    cleanupExpired(now);
  }

  const entry = phoneLimitMap.get(phoneKey);

  if (!entry || now > entry.resetAt) {
    phoneLimitMap.set(phoneKey, { count: 1, resetAt: now + WINDOW_MS });
    return "allowed";
  }

  entry.count++;

  if (entry.count === limit + 1) {
    // C4 FIX: First time exceeding limit — send notification
    return "first_block";
  }

  if (entry.count > limit + 1) {
    // C4 FIX: Already notified — silently drop to avoid spam
    return "silent_block";
  }

  return "allowed";
}

/**
 * Send a rate-limit notification to the user.
 * Fire-and-forget; errors are logged but don't propagate.
 */
export async function sendRateLimitMessage(phone: string): Promise<void> {
  try {
    await sendText(
      phone,
      "\u23f3 Demasiados mensajes. Esperá un minuto antes de enviar otro. \ud83d\ude4f",
    );
  } catch {
    // Best-effort
  }
}

// ─── Cleanup ────────────────────────────────────────────

function cleanupExpired(now: number): void {
  let cleaned = 0;
  for (const [key, entry] of phoneLimitMap) {
    if (now > entry.resetAt) {
      phoneLimitMap.delete(key);
      cleaned++;
    }
  }
  lastCleanup = now;
  if (cleaned > 0) {
    console.warn(`[WA-RateLimit] Cleaned ${cleaned} expired entries`);
  }
}

/** Returns the current map size (for health checks/diagnostics). */
export function getRateLimitMapSize(): number {
  return phoneLimitMap.size;
}

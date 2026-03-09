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
 * Implementation: In-memory Map (same pattern as rate-limit.ts).
 * Trade-off: per-isolate counters. At Axon's scale, this is acceptable.
 */

import { sendText } from "./wa-client.ts";

// ─── Configuration ───────────────────────────────────────

const WINDOW_MS = 60_000; // 1 minute
const LINKED_LIMIT = 30;   // 30 msg/min for linked users
const UNLINKED_LIMIT = 10; // 10 msg/min for unlinked/unknown
const CLEANUP_INTERVAL_MS = 5 * 60_000; // Cleanup every 5 min

// ─── State ──────────────────────────────────────────────

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const phoneLimitMap = new Map<string, RateLimitEntry>();
let lastCleanup = Date.now();

// ─── Core ───────────────────────────────────────────────

/**
 * Check if a phone number has exceeded its rate limit.
 *
 * @param phoneKey - Phone hash or raw phone (for unlinked users pre-hash)
 * @param isLinked - Whether the user is linked (affects limit)
 * @returns true if request should be BLOCKED (rate limited)
 */
export function checkWhatsAppRateLimit(
  phoneKey: string,
  isLinked: boolean,
): boolean {
  const now = Date.now();
  const limit = isLinked ? LINKED_LIMIT : UNLINKED_LIMIT;

  // Periodic cleanup
  if (now - lastCleanup > CLEANUP_INTERVAL_MS) {
    cleanupExpired(now);
  }

  const entry = phoneLimitMap.get(phoneKey);

  if (!entry || now > entry.resetAt) {
    phoneLimitMap.set(phoneKey, { count: 1, resetAt: now + WINDOW_MS });
    return false; // allowed
  }

  entry.count++;

  if (entry.count > limit) {
    return true; // BLOCKED
  }

  return false; // allowed
}

/**
 * Send a rate-limit notification to the user.
 * Fire-and-forget; errors are logged but don't propagate.
 */
export async function sendRateLimitMessage(phone: string): Promise<void> {
  try {
    await sendText(
      phone,
      "\u23f3 Demasiados mensajes. Esper\u00e1 un minuto antes de enviar otro. \ud83d\ude4f",
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
    console.log(`[WA-RateLimit] Cleaned ${cleaned} expired entries`);
  }
}

// ─── Testing / Observability ────────────────────────────

/** Returns the current map size (for health checks/diagnostics). */
export function getRateLimitMapSize(): number {
  return phoneLimitMap.size;
}

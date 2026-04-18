/**
 * routes/_messaging/rate-limit-base.ts — Shared rate-limit logic
 *
 * Parameterized factory used by:
 *   - routes/telegram/tg-rate-limit.ts
 *   - routes/whatsapp/wa-rate-limit.ts
 *
 * Same behavior as the original per-channel modules:
 *   - In-memory sliding window keyed by caller-chosen key (chat id, phone hash)
 *   - Linked users: 30 msg/min · Unlinked users: 10 msg/min
 *   - Three-state result: allowed / first_block / silent_block
 *   - Periodic cleanup of expired entries every 5 minutes
 *
 * Each channel builds its own limiter via createRateLimiter() so the
 * in-memory map is isolated per channel (no cross-channel interference).
 */

// ─── Configuration (shared across channels) ──────────────

const WINDOW_MS = 60_000; // 1 minute
const LINKED_LIMIT = 30;
const UNLINKED_LIMIT = 10;
const CLEANUP_INTERVAL_MS = 5 * 60_000;

// ─── Types ───────────────────────────────────────────────

export type RateLimitResult = "allowed" | "first_block" | "silent_block";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export interface RateLimiterConfig {
  /** Short label used in cleanup log lines, e.g. "TG-RateLimit" or "WA-RateLimit". */
  logLabel: string;
  /**
   * Sends the rate-limit notification to the caller. Implementation is
   * channel-specific (sendTextPlain for Telegram, sendText for WhatsApp).
   * Errors must be swallowed by the caller — this is best-effort.
   */
  sendNotification: (target: string | number, message: string) => Promise<void>;
}

export interface RateLimiter {
  /**
   * Check whether the given key has exceeded its rate limit.
   * Mutates in-memory state (increments counter).
   */
  check: (key: string, isLinked: boolean) => RateLimitResult;
  /** Fire-and-forget rate limit message. */
  sendRateLimitMessage: (target: string | number) => Promise<void>;
  /** Current size of the in-memory map (for diagnostics/health checks). */
  getMapSize: () => number;
}

// ─── Factory ─────────────────────────────────────────────

const RATE_LIMIT_TEXT =
  "\u23f3 Demasiados mensajes. Esperá un minuto antes de enviar otro. \ud83d\ude4f";

/**
 * Creates an isolated rate limiter with its own in-memory map.
 * Each channel should call this exactly once at module load.
 */
export function createRateLimiter(config: RateLimiterConfig): RateLimiter {
  const limitMap = new Map<string, RateLimitEntry>();
  let lastCleanup = Date.now();

  function cleanupExpired(now: number): void {
    let cleaned = 0;
    for (const [key, entry] of limitMap) {
      if (now > entry.resetAt) {
        limitMap.delete(key);
        cleaned++;
      }
    }
    lastCleanup = now;
    if (cleaned > 0) {
      console.warn(`[${config.logLabel}] Cleaned ${cleaned} expired entries`);
    }
  }

  function check(key: string, isLinked: boolean): RateLimitResult {
    const now = Date.now();
    const limit = isLinked ? LINKED_LIMIT : UNLINKED_LIMIT;

    if (now - lastCleanup > CLEANUP_INTERVAL_MS) {
      cleanupExpired(now);
    }

    const entry = limitMap.get(key);

    if (!entry || now > entry.resetAt) {
      limitMap.set(key, { count: 1, resetAt: now + WINDOW_MS });
      return "allowed";
    }

    entry.count++;

    if (entry.count === limit + 1) return "first_block";
    if (entry.count > limit + 1) return "silent_block";

    return "allowed";
  }

  async function sendRateLimitMessage(target: string | number): Promise<void> {
    try {
      await config.sendNotification(target, RATE_LIMIT_TEXT);
    } catch {
      // Best-effort — errors are intentionally swallowed
    }
  }

  function getMapSize(): number {
    return limitMap.size;
  }

  return { check, sendRateLimitMessage, getMapSize };
}
